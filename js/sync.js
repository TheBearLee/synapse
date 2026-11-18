/* Synapse — sync across devices through a private GitHub repository.
 *
 * Every device keeps its full vault in IndexedDB (offline-first). A sync:
 *   1. reads the repo's latest commit tree,
 *   2. downloads only files whose git blob SHA changed since this device last synced,
 *   3. merges page by page (newer edit wins; if both sides changed, the loser is kept as a "conflict" copy),
 *   4. uploads local changes as ONE commit (git data API), fast-forward only — retries if another device won the race.
 *
 * Repo layout:  pages/<Title>.md   trash/<Title>.md   attachments/<id>--<name>
 * Each .md has YAML frontmatter with a `synapse:` line holding the page's metadata as JSON,
 * so files stay readable (and editable) on GitHub or in Obsidian.
 */
(function (S) {
  'use strict';
  const CFG_KEY = 'syncConfig';
  const STATE_KEY = 'syncState';
  const sync = S.sync = { apiBase: 'https://api.github.com', busy: false, status: 'off', error: '', applying: false };

  /* ---------- config / state ---------- */
  sync.config = () => { try { return JSON.parse(localStorage.getItem(CFG_KEY)) || null; } catch { return null; } };
  sync.saveConfig = (c) => c ? localStorage.setItem(CFG_KEY, JSON.stringify(c)) : localStorage.removeItem(CFG_KEY);
  const loadState = () => { try { return JSON.parse(localStorage.getItem(STATE_KEY)) || { commit: null, pages: {}, atts: {} }; } catch { return { commit: null, pages: {}, atts: {} }; } };
  const saveState = (s) => localStorage.setItem(STATE_KEY, JSON.stringify(s));
  sync.lastSync = () => +localStorage.getItem('syncLast') || 0;

  /* ---------- GitHub API ---------- */
  async function api(path, { method = 'GET', body, cfg } = {}) {
    const c = cfg || sync.config();
    const url = `${c.apiBase || sync.apiBase}/repos/${c.owner}/${c.repo}${path ? '/' + path : ''}`;
    const res = await fetch(url, {
      method, cache: 'no-store',
      headers: Object.assign({ Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).message || ''; } catch { /* ignore */ }
      const e = new Error(res.status === 401 ? 'GitHub token is invalid or expired' : res.status === 404 ? 'Repository not found, or the token has no access to it' : res.status === 403 && /rate limit/i.test(msg) ? 'GitHub rate limit reached — try again later' : `GitHub ${res.status}: ${msg}`);
      e.status = res.status; e.ghMessage = msg;
      throw e;
    }
    return res.status === 204 ? null : res.json();
  }
  sync.api = api;

  const utf8 = new TextEncoder(), unutf8 = new TextDecoder();
  const b64ToBytes = (b64) => { const bin = atob(b64.replace(/\s/g, '')); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };
  const bytesToB64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };

  async function getHead(cfg) {
    try {
      const ref = await api(`git/ref/heads/${encodeURIComponent(cfg.branch)}`, { cfg });
      const commit = await api(`git/commits/${ref.object.sha}`, { cfg });
      return { commit: ref.object.sha, tree: commit.tree.sha };
    } catch (e) {
      if (e.status === 409 || e.status === 404) return null; // empty repository
      throw e;
    }
  }
  async function initRepo(cfg) {
    const text = '# Synapse vault\n\nThis private repository is synced by [Synapse](https://thebearlee.github.io/synapse/).\nNotes live in `pages/`, trashed notes in `trash/`, images in `attachments/`.\n';
    await api('contents/README.md', { method: 'PUT', cfg, body: { message: 'Initialise Synapse vault', content: bytesToB64(utf8.encode(text)), branch: cfg.branch } });
  }
  async function blobBytes(sha, cfg) { const b = await api(`git/blobs/${sha}`, { cfg }); return b64ToBytes(b.content); }

  async function pool(items, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
  }

  /* ---------- file format ---------- */
  const safeName = (s) => (String(s).replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, '').replace(/\s+/g, ' ').replace(/^\.+/, '').trim() || 'Untitled').slice(0, 100);

  sync.serialize = (p) => {
    const meta = Object.assign({}, p);
    delete meta.content;
    const tags = S.pageTags ? S.pageTags(p.id) : [];
    return ['---', `title: ${JSON.stringify(p.title)}`, `type: ${p.type}`, tags.length ? `tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]` : null,
      `synapse: ${JSON.stringify(meta)}`, '---', ''].filter((l) => l != null).join('\n') + (p.content || '');
  };

  sync.parse = (text, path) => {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    let meta = null;
    if (m) {
      const line = m[1].split(/\r?\n/).find((l) => l.startsWith('synapse:'));
      if (line) { try { meta = JSON.parse(line.slice(8).trim()); } catch { meta = null; } }
    }
    if (meta && meta.id) {
      const page = S.normalizePage(Object.assign(meta, { content: text.slice(m[0].length) }));
      return { page, foreign: false };
    }
    // A Markdown file added outside Synapse (GitHub web editor, Obsidian…): import it.
    const { meta: fm, body } = S.splitFrontmatter(text);
    const title = fm.title || path.split('/').pop().replace(/\.md$/i, '');
    const page = S.newPage({ title, content: body, type: S.TYPES[fm.type] ? fm.type : 'note', deleted: path.startsWith('trash/') });
    return { page, foreign: true };
  };

  /* ---------- status ---------- */
  sync.listeners = new Set();
  function setStatus(s, err = '') { sync.status = s; sync.error = err; sync.listeners.forEach((f) => f()); }

  /* ---------- core ---------- */
  sync.isDirty = async () => {
    const st = loadState();
    for (const p of S.pages.values()) { const k = st.pages[p.id]; if (!k || k.updated !== p.updated) return true; }
    for (const id of Object.keys(st.pages)) if (!S.pages.has(id)) return true;
    const keys = await S.db.attachmentKeys();
    return keys.some((k) => !st.atts[k]);
  };

  sync.run = async (opts = {}) => {
    const cfg = sync.config();
    if (!cfg) return;
    if (sync.busy) { sync.again = true; return; }
    if (!navigator.onLine && !opts.force) { setStatus('offline'); return; }
    sync.busy = true;
    setStatus('syncing');
    try {
      S.app && S.app.flush && S.app.flush();
      const res = await doSync(cfg, 0);
      localStorage.setItem('syncLast', Date.now());
      setStatus('ok');
      if (res && (res.pulled || res.conflicts)) {
        S.reindexAll();
        S.app && S.app.afterSync && S.app.afterSync(res);
      }
      return res;
    } catch (e) {
      console.warn('Sync failed', e);
      setStatus('error', e.message);
      if (opts.throw) throw e;
    } finally {
      sync.busy = false;
      if (sync.again) { sync.again = false; sync.schedule(1500); }
    }
  };

  async function doSync(cfg, attempt) {
    let head = await getHead(cfg);
    if (!head) { await initRepo(cfg); head = await getHead(cfg); }
    const st = loadState();
    if (head.commit === st.commit && !(await sync.isDirty())) return { pulled: 0, pushed: 0 };

    const treeRes = await api(`git/trees/${head.tree}?recursive=1`, { cfg });
    if (treeRes.truncated) throw new Error('Vault repository is too large to read in one go');
    const files = treeRes.tree.filter((t) => t.type === 'blob');

    /* ---- remote pages ---- */
    const pathToId = new Map(Object.entries(st.pages).map(([id, v]) => [v.path, id]));
    const remote = new Map(); // id -> {path, sha, page?, unchanged, foreign}
    const toFetch = [];
    for (const f of files) {
      if (!/^(pages|trash)\/[^/]+\.md$/i.test(f.path)) continue;
      const id = pathToId.get(f.path);
      if (id && st.pages[id].sha === f.sha) remote.set(id, { path: f.path, sha: f.sha, unchanged: true });
      else toFetch.push(f);
    }
    await pool(toFetch, 6, async (f) => {
      const { page, foreign } = sync.parse(unutf8.decode(await blobBytes(f.sha, cfg)), f.path);
      const prev = remote.get(page.id);
      // duplicate id at two paths (copied file) → keep the newer, treat the other as foreign
      if (prev && prev.page && (prev.page.updated || 0) >= (page.updated || 0)) { page.id = S.uid('p_'); remote.set(page.id, { path: f.path, sha: f.sha, page, foreign: true }); return; }
      remote.set(page.id, { path: f.path, sha: f.sha, page, foreign });
    });

    /* ---- merge ---- */
    const newState = { commit: null, pages: {}, atts: {} };
    const uploads = [];      // pages to write
    const deletes = new Set(); // remote paths to remove
    const applied = [];      // pages updated locally from remote
    let conflicts = 0;
    const stamp = new Date().toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    const applyLocal = async (page) => { S.normalizePage(page); await S.db.putPage(page); applied.push(page.id); };
    const ids = new Set([...S.pages.keys(), ...remote.keys(), ...Object.keys(st.pages)]);
    sync.applying = true;
    try {
      for (const id of ids) {
        const local = S.pages.get(id);
        const r = remote.get(id);
        const known = st.pages[id];
        const localChanged = !!local && (!known || local.updated !== known.updated);
        const remoteChanged = !!r && !r.unchanged && (!known || r.sha !== known.sha || r.foreign);
        if (local && r) {
          if (remoteChanged && localChanged) {
            if (sync.serialize(local) === sync.serialize(r.page)) newState.pages[id] = { path: r.path, sha: r.sha, updated: local.updated };
            else {
              conflicts++;
              const remoteWins = (r.page.updated || 0) > (local.updated || 0);
              const loser = remoteWins ? local : r.page;
              const copy = S.normalizePage(Object.assign(JSON.parse(JSON.stringify(loser)), { id: S.uid('p_'), favorite: false, title: `${loser.title} (conflict ${stamp})`, updated: Date.now() }));
              await applyLocal(copy); uploads.push(copy);
              if (remoteWins) { await applyLocal(r.page); newState.pages[id] = { path: r.path, sha: r.sha, updated: r.page.updated }; }
              else uploads.push(local);
            }
          } else if (remoteChanged) {
            await applyLocal(r.page);
            newState.pages[id] = { path: r.path, sha: r.sha, updated: r.page.updated };
            if (r.foreign) uploads.push(r.page); // rewrite with Synapse metadata
            if (r.foreign) deletes.add(r.path);
          } else if (localChanged) uploads.push(local);
          else newState.pages[id] = { path: r.path, sha: r.sha, updated: known.updated };
        } else if (local && !r) {
          if (known && !localChanged) { await S.db.deletePageHard(id); applied.push(id); } // deleted on another device
          else uploads.push(local);
        } else if (!local && r) {
          if (known && !remoteChanged) deletes.add(r.path); // deleted here
          else {
            const page = r.page || null;
            if (page) {
              await applyLocal(page);
              newState.pages[page.id] = { path: r.path, sha: r.sha, updated: page.updated };
              if (r.foreign) { uploads.push(page); deletes.add(r.path); }
            }
          }
        }
      }
    } finally { sync.applying = false; }

    /* ---- attachments ---- */
    const remoteAtts = new Map();
    for (const f of files) {
      const m = f.path.match(/^attachments\/([^/]+?)(?:--[^/]*)?$/);
      if (m) remoteAtts.set(m[1].replace(/\.[^.]+$/, ''), f);
    }
    const localKeys = new Set(await S.db.attachmentKeys());
    const attUploads = [];
    for (const id of localKeys) {
      if (remoteAtts.has(id)) newState.atts[id] = remoteAtts.get(id).path;
      else attUploads.push(id);
    }
    const attDownloads = [...remoteAtts].filter(([id]) => !localKeys.has(id));
    await pool(attDownloads, 4, async ([id, f]) => {
      const bytes = await blobBytes(f.sha, cfg);
      const name = (f.path.split('--').slice(1).join('--')) || id;
      const mime = mimeOf(name);
      sync.applying = true;
      try { await S.db.putAttachmentRecord({ id, name, mime, created: Date.now(), blob: new Blob([bytes], { type: mime }) }); } finally { sync.applying = false; }
      newState.atts[id] = f.path;
    });

    /* ---- push ---- */
    const entries = [];
    const occupied = new Map();
    for (const [id, r] of remote) occupied.set(r.path.toLowerCase(), id);
    for (const p of deletes) occupied.delete(p.toLowerCase());
    const pathFor = (p) => {
      const folder = p.deleted ? 'trash/' : 'pages/';
      const base = folder + safeName(p.title);
      let path = base + '.md';
      const holder = occupied.get(path.toLowerCase());
      if (holder && holder !== p.id) path = `${base} (${p.id}).md`;
      return path;
    };
    const seen = new Set();
    for (const p of uploads) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const old = remote.get(p.id);
      const path = pathFor(p);
      if (old && old.path !== path) { deletes.add(old.path); occupied.delete(old.path.toLowerCase()); }
      deletes.delete(path);
      occupied.set(path.toLowerCase(), p.id);
      const blob = await api('git/blobs', { method: 'POST', cfg, body: { content: sync.serialize(p), encoding: 'utf-8' } });
      entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
      newState.pages[p.id] = { path, sha: blob.sha, updated: p.updated };
    }
    for (const id of attUploads) {
      const rec = await S.db.getAttachment(id);
      if (!rec) continue;
      const path = `attachments/${id}--${safeName(rec.name || 'file').replace(/\s/g, '_')}`;
      const blob = await api('git/blobs', { method: 'POST', cfg, body: { content: bytesToB64(new Uint8Array(await rec.blob.arrayBuffer())), encoding: 'base64' } });
      entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
      newState.atts[id] = path;
    }
    for (const path of deletes) if (files.some((f) => f.path === path)) entries.push({ path, mode: '100644', type: 'blob', sha: null });

    let commitSha = head.commit;
    if (entries.length) {
      const tree = await api('git/trees', { method: 'POST', cfg, body: { base_tree: head.tree, tree: entries } });
      const n = uploads.length + attUploads.length;
      const commit = await api('git/commits', { method: 'POST', cfg, body: {
        message: `Sync from ${deviceName()}: ${n} change${n === 1 ? '' : 's'}${deletes.size ? `, ${deletes.size} removal${deletes.size === 1 ? '' : 's'}` : ''}`,
        tree: tree.sha, parents: [head.commit] } });
      try {
        await api(`git/refs/heads/${encodeURIComponent(cfg.branch)}`, { method: 'PATCH', cfg, body: { sha: commit.sha, force: false } });
      } catch (e) {
        if (e.status === 422 && attempt < 3) { // another device pushed first: merge again on top of it
          const res = await doSync(cfg, attempt + 1);
          res.pulled += applied.length; res.conflicts += conflicts;
          return res;
        }
        throw e;
      }
      commitSha = commit.sha;
    }
    newState.commit = commitSha;
    saveState(newState);
    return { pulled: applied.length, pushed: entries.length, conflicts, applied };
  }

  function mimeOf(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', pdf: 'application/pdf' })[ext] || 'application/octet-stream';
  }
  function deviceName() {
    const ua = navigator.userAgent;
    const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'device';
    const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
    return `${br} on ${os}`;
  }

  /* ---------- connect / disconnect ---------- */
  sync.connect = async (repoFull, token) => {
    const m = String(repoFull).trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').match(/^([\w.-]+)\/([\w.-]+)$/);
    if (!m) throw new Error('Enter the repository as owner/name, e.g. TheBearLee/synapse-vault');
    const cfg = { owner: m[1], repo: m[2], token: token.trim(), branch: 'main', auto: true };
    const info = await api('', { cfg });
    if (info.permissions && !info.permissions.push) throw new Error('This token can read the repository but cannot write to it. Give it “Contents: Read and write”.');
    cfg.branch = info.default_branch || 'main';
    cfg.private = !!info.private;
    const head = await getHead(cfg);
    let remotePages = 0;
    if (head) {
      const t = await api(`git/trees/${head.tree}?recursive=1`, { cfg });
      remotePages = t.tree.filter((f) => /^(pages|trash)\/.*\.md$/i.test(f.path)).length;
    }
    return { cfg, private: !!info.private, remotePages };
  };
  sync.finishConnect = (cfg) => {
    sync.saveConfig(cfg);
    saveState({ commit: null, pages: {}, atts: {} });
    setStatus('idle');
  };
  sync.disconnect = () => {
    sync.saveConfig(null);
    localStorage.removeItem(STATE_KEY);
    localStorage.removeItem('syncLast');
    setStatus('off');
  };

  /* ---------- automatic syncing ---------- */
  let timer = null;
  sync.schedule = (ms = 15000) => {
    const c = sync.config();
    if (!c || c.auto === false) return;
    clearTimeout(timer);
    timer = setTimeout(() => sync.run(), ms);
  };
  // any local write schedules a sync
  const wrap = (name) => {
    const orig = S.db[name].bind(S.db);
    S.db[name] = async (...a) => { const r = await orig(...a); if (!sync.applying && sync.config()) { setStatus('pending'); sync.schedule(); } return r; };
  };
  ['putPage', 'deletePageHard', 'putAttachment'].forEach(wrap);

  sync.start = () => {
    const c = sync.config();
    setStatus(c ? 'idle' : 'off');
    if (!c) return;
    setTimeout(() => sync.run(), 1200);
    setInterval(() => { if (sync.config() && sync.config().auto !== false && document.visibilityState === 'visible') sync.run(); }, 3 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (!sync.config()) return;
      if (document.visibilityState === 'visible' && Date.now() - sync.lastSync() > 30000) sync.run();
      if (document.visibilityState === 'hidden' && sync.status === 'pending') sync.run();
    });
    window.addEventListener('online', () => sync.config() && sync.run());
  };
})(window.S);
