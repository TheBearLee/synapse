/* Synapse — app shell: routing, sidebar, home, graph, search, trash, palette, settings. */
(function (S) {
  'use strict';
  const h = S.h;
  const $ = (id) => document.getElementById(id);

  S.state = {
    mode: localStorage.getItem('mode') || (innerWidth > 1300 ? 'split' : 'read'),
    right: localStorage.getItem('right') !== '0' && innerWidth > 1000,
    sidebar: localStorage.getItem('sidebar') !== '0' && innerWidth > 760,
    current: null,
    params: {},
    treeSort: localStorage.getItem('treeSort') || 'title',
    expanded: new Set(JSON.parse(localStorage.getItem('expanded') || '[]')),
  };
  let view = null; // current view object with destroy()

  const app = S.app = {};

  /* ---------- theme ---------- */
  app.applyTheme = () => {
    const t = localStorage.getItem('theme') || 'system';
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    document.documentElement.style.setProperty('--editor-size', (localStorage.getItem('fontSize') || '16') + 'px');
    document.documentElement.classList.toggle('wide-pages', localStorage.getItem('wide') === '1');
  };

  /* ---------- pages ---------- */
  app.uniqueTitle = (t) => {
    let title = t, i = 2;
    while (S.findByTitle(title)) title = `${t} ${i++}`;
    return title;
  };
  app.createPage = async (fields = {}, { open = true } = {}) => {
    const p = S.newPage(Object.assign({}, fields, { title: app.uniqueTitle((fields.title || 'Untitled').replace(/[\[\]|#@]/g, '')) }));
    if (p.type === 'canvas' && !p.canvas) p.canvas = S.emptyCanvas();
    await S.db.putPage(p);
    S.rebuildTitles();
    S.reindexAll();
    if (p.parentId) { S.state.expanded.add(p.parentId); saveExpanded(); }
    if (open) location.hash = '#/page/' + p.id + '?new=1';
    app.refresh();
    return p;
  };
  app.openTitle = async (title, extra = {}) => {
    const p = S.findByTitle(title);
    if (p) { location.hash = '#/page/' + p.id + (extra.h ? '?h=' + encodeURIComponent(S.slug(extra.h)) : extra.loc ? '?loc=' + encodeURIComponent(extra.loc) : ''); return; }
    const created = await app.createPage({ title, parentId: null }, { open: false });
    S.reindexAll();
    location.hash = '#/page/' + created.id;
    S.toast(`Created “${created.title}”`);
  };
  app.trash = async (p) => {
    const ts = Date.now();
    const kill = async (x) => {
      x.deleted = true; x.deletedAt = ts; x.updated = Date.now(); await S.db.putPage(x);
      for (const c of S.livePages().filter((c) => c.parentId === x.id)) await kill(c);
    };
    await kill(p);
    S.reindexAll();
    S.toast(`Moved “${p.title}” to trash`);
    if (S.state.current === p.id) location.hash = '#/home';
    app.refresh();
  };
  app.restore = async (p) => {
    const batch = [...S.pages.values()].filter((x) => x.deleted && x.deletedAt === p.deletedAt);
    for (const x of batch) {
      x.deleted = false; delete x.deletedAt; x.updated = Date.now();
      if (S.findByTitle(x.title) && S.findByTitle(x.title).id !== x.id) x.title = app.uniqueTitle(x.title);
      S.rebuildTitles();
    }
    for (const x of batch) {
      if (x.parentId && (!S.pages.has(x.parentId) || S.pages.get(x.parentId).deleted)) x.parentId = null;
      await S.db.putPage(x);
    }
    S.reindexAll();
    app.refresh();
  };
  app.duplicate = async (p) => {
    const copy = JSON.parse(JSON.stringify(p));
    delete copy.id;
    copy.title = p.title + ' copy';
    copy.favorite = false;
    copy.created = copy.updated = Date.now();
    return app.createPage(copy);
  };
  app.toggleFav = async (p) => { p.favorite = !p.favorite; await S.db.putPage(p); app.refresh(); renderTopbar(); };
  app.linkMention = async (from, to) => {
    const re = new RegExp('(^|[^\\p{L}\\p{N}\\[])(' + to.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?![\\p{L}\\p{N}\\]])', 'iu');
    if (!re.test(from.content)) { S.toast('Mention is inside a diagram — open it to link'); return; }
    from.content = from.content.replace(re, (m, pre, word) => pre + (word === to.title ? `[[${to.title}]]` : `[[${to.title}|${word}]]`));
    from.updated = Date.now();
    await S.db.putPage(from);
    S.indexPage(from);
    S.toast(`Linked in “${from.title}”`);
    app.refresh();
  };
  app.dailyNote = async () => {
    const title = S.isoDay();
    const ex = S.findByTitle(title);
    if (ex) { location.hash = '#/page/' + ex.id; return; }
    const tpl = S.livePages().find((p) => p.type === 'template' && p.title.toLowerCase() === 'daily');
    await app.createPage({ title, type: 'daily', icon: '📅', content: tpl ? S.fillTemplate(tpl.content, title) : '' }, { open: false });
    S.reindexAll();
    location.hash = '#/page/' + S.findByTitle(title).id;
  };
  app.newFromTemplate = async () => {
    const t = await S.pickPage('New page from template', (x) => x.type === 'template');
    if (!t) return;
    const title = await S.prompt('Title for the new page', '');
    if (title == null) return;
    const type = /book/i.test(t.title) ? 'book' : 'note';
    app.createPage({ title: title || 'Untitled', type, content: S.fillTemplate(t.content, title) });
  };
  app.randomNote = () => {
    const ps = S.livePages().filter((p) => p.type !== 'template' && p.type !== 'daily');
    if (ps.length) location.hash = '#/page/' + ps[Math.floor(Math.random() * ps.length)].id;
  };

  /* ---------- sync hooks ---------- */
  app.flush = () => { if (view && view.save && view.save.flush) view.save.flush(); };
  app.afterSync = (res) => {
    const cur = S.state.current;
    if (cur && res.applied && res.applied.includes(cur)) route();
    else app.refresh();
    if (res.conflicts) S.toast(`Synced — ${res.conflicts} conflict${res.conflicts > 1 ? 's' : ''} saved as “(conflict …)” copies`, 5000);
    else if (res.pulled) S.toast(`Synced ${res.pulled} change${res.pulled > 1 ? 's' : ''} from your other devices`);
  };
  function renderSyncStatus() {
    const b = $('sync-status');
    const sy = S.sync;
    if (!sy || sy.status === 'off') { b.hidden = true; return; }
    b.hidden = false;
    const last = sy.lastSync();
    const label = {
      syncing: '⟳ Syncing…', pending: '☁ Unsynced', offline: '☁ Offline', error: '⚠ Sync error',
      ok: '☁ Synced', idle: last ? '☁ Synced' : '☁ Not synced yet',
    }[sy.status] || '☁';
    b.textContent = label;
    b.className = 'mini sync-status s-' + sy.status;
    b.title = (sy.status === 'error' ? sy.error + '\n' : '') + (last ? 'Last synced ' + S.ago(last) : 'Never synced') + ' · click to sync now';
  }
  app.renderSyncStatus = renderSyncStatus;

  function syncSection(m) {
    const cfg = S.sync.config();
    const wrap = h('div');
    if (!cfg) {
      const repoIn = h('input.input', { placeholder: 'owner/repository  e.g. TheBearLee/synapse-vault', value: localStorage.getItem('syncRepoHint') || '' });
      const tokIn = h('input.input', { type: 'password', placeholder: 'Fine-grained personal access token (github_pat_…)', autocomplete: 'off' });
      const err = h('div.small.err');
      const btn = h('button.btn.primary', { onclick: async () => {
        err.textContent = '';
        btn.disabled = true; btn.textContent = 'Connecting…';
        try {
          localStorage.setItem('syncRepoHint', repoIn.value.trim());
          const res = await S.sync.connect(repoIn.value, tokIn.value);
          if (!res.private && !(await S.confirm('This repository is PUBLIC', `Anyone on the internet could read your notes in ${res.cfg.owner}/${res.cfg.repo}. Make it private on GitHub first (recommended), or continue anyway?`, 'Use it anyway'))) throw new Error('Cancelled — make the repository private, then connect again.');
          const localCount = S.livePages().length;
          if (res.remotePages && localCount) {
            const replace = await S.confirm('Your cloud vault already has notes',
              `${res.remotePages} notes are in GitHub and ${localCount} are on this device. Replace this device’s notes with the cloud copy? (Choose Cancel to merge both — fine if this device has notes you want to keep.)`, 'Replace this device');
            if (replace) await S.db.clearAll();
          }
          S.sync.finishConnect(res.cfg);
          tokIn.value = '';
          await S.sync.run({ force: true, throw: true });
          S.reindexAll();
          S.toast('Sync connected ✓');
          m.close(); openSettings(); route();
        } catch (e) {
          err.textContent = e.message;
          if (S.sync.config()) { S.sync.disconnect(); }
        } finally { btn.disabled = false; btn.textContent = 'Connect'; }
      } }, 'Connect');
      wrap.append(
        h('p.small.muted', 'Sync your vault across computers and phones through a private GitHub repository. Notes still work offline; changes sync whenever you’re online.'),
        h('ol.small.steps',
          h('li', h('a', { href: 'https://github.com/new?name=synapse-vault&visibility=private', target: '_blank', rel: 'noopener' }, 'Create a private repository'), ' (e.g. ', h('code', 'synapse-vault'), ').'),
          h('li', h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' }, 'Create a fine-grained token'),
            ': Repository access → ', h('b', 'Only select repositories'), ' → your vault; Permissions → ', h('b', 'Contents: Read and write'), '.'),
          h('li', 'Paste both below. Do the same on each device (you can reuse the token).')),
        repoIn, tokIn, h('div.row', btn), err,
        h('p.small.muted', '🔒 The token is stored only in this browser and is sent only to api.github.com.'));
    } else {
      const sy = S.sync;
      const st = h('div.small', sy.status === 'error' ? h('span.err', '⚠ ' + sy.error) : `Last synced ${sy.lastSync() ? S.ago(sy.lastSync()) : 'never'}`);
      const auto = h('input', { type: 'checkbox', checked: cfg.auto !== false, onchange: () => { cfg.auto = auto.checked; sy.saveConfig(cfg); } });
      wrap.append(
        h('div.row.wrap', h('span.pill.ok', '☁ Connected'), h('a', { href: `https://github.com/${cfg.owner}/${cfg.repo}`, target: '_blank', rel: 'noopener' }, `${cfg.owner}/${cfg.repo}`), cfg.private === false ? h('span.pill', 'public!') : null),
        st,
        h('div.row.wrap',
          h('button.btn.primary', { onclick: async () => { await sy.run({ force: true }); m.close(); openSettings(); } }, '⟳ Sync now'),
          h('label.switch', auto, 'Sync automatically'),
          h('button.btn.danger', { onclick: async () => {
            if (!(await S.confirm('Disconnect sync?', 'Your notes stay on this device and in GitHub; this device just stops syncing and forgets the token.', 'Disconnect'))) return;
            sy.disconnect(); m.close(); openSettings();
          } }, 'Disconnect')));
    }
    return wrap;
  }

  /* ---------- refresh after edits ---------- */
  app.refresh = () => { S.rebuildTitles(); renderSidebar(); if (S.state.current && S.state.right) renderRight(); renderTopbar(); };
  app.refreshSoon = S.debounce(() => {
    S.rebuildTitles();
    renderSidebar();
    if (S.state.current && S.state.right && !document.activeElement.closest('#rightpanel')) {
      const rp = $('rightpanel');
      if ((localStorage.getItem('rpTab') || 'links') !== 'graph') renderRight();
      else if (S.rpGraph) S.rpGraph.update({});
      void rp;
    }
  }, 900);

  app.setMode = (m) => {
    S.state.mode = m;
    localStorage.setItem('mode', m);
    if (view && view.wrap) {
      view.wrap.className = view.wrap.className.replace(/mode-\w+/, 'mode-' + m);
      view.autosize && view.autosize();
      if (m !== 'edit') view.updatePreview();
    }
    renderTopbar();
  };

  /* ---------- sidebar ---------- */
  function saveExpanded() { localStorage.setItem('expanded', JSON.stringify([...S.state.expanded])); }

  function treeItem(p, kids, depth) {
    const children = kids.get(p.id) || [];
    const open = S.state.expanded.has(p.id);
    const row = h('div.tree-row' + (S.state.current === p.id ? '.active' : ''), {
      style: { paddingLeft: 6 + depth * 14 + 'px' }, draggable: true, 'data-id': p.id,
      ondragstart: (e) => { e.dataTransfer.setData('text/synapse-page', p.id); e.dataTransfer.effectAllowed = 'copyMove'; },
      ondragover: (e) => { if (e.dataTransfer.types.includes('text/synapse-page')) { e.preventDefault(); row.classList.add('drop'); } },
      ondragleave: () => row.classList.remove('drop'),
      ondrop: async (e) => {
        e.preventDefault(); row.classList.remove('drop');
        const id = e.dataTransfer.getData('text/synapse-page');
        const moved = S.pages.get(id);
        if (!moved || id === p.id) return;
        for (let a = p; a; a = a.parentId && S.pages.get(a.parentId)) if (a.id === id) { S.toast('Can’t move a page inside itself'); return; }
        moved.parentId = p.id; moved.updated = Date.now();
        await S.db.putPage(moved);
        S.state.expanded.add(p.id); saveExpanded();
        app.refresh();
      },
      oncontextmenu: (e) => { e.preventDefault(); pageMenu(p, e.clientX, e.clientY); },
    },
    h('button.caret' + (children.length ? '' : '.empty'), {
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); open ? S.state.expanded.delete(p.id) : S.state.expanded.add(p.id); saveExpanded(); renderSidebar(); },
    }, children.length ? (open ? '▾' : '▸') : '•'),
    h('a.tree-link', { href: '#/page/' + p.id }, h('span.ic', S.pageIcon(p)), h('span.tt', p.title)),
    h('button.row-act', { title: 'Add sub-page', onclick: (e) => { e.preventDefault(); app.createPage({ parentId: p.id }); } }, '＋'),
    h('button.row-act', { title: 'More', onclick: (e) => { e.preventDefault(); const r = e.target.getBoundingClientRect(); pageMenu(p, r.left, r.bottom); } }, '⋯'));
    const frag = [row];
    if (open) for (const c of children) frag.push(...treeItem(c, kids, depth + 1));
    return frag;
  }

  function pageMenu(p, x, y) {
    S.menu(x, y, [
      { label: '↗ Open', run: () => { location.hash = '#/page/' + p.id; } },
      { label: '＋ Add sub-page', run: () => app.createPage({ parentId: p.id }) },
      { label: p.favorite ? '☆ Remove from favorites' : '★ Add to favorites', run: () => app.toggleFav(p) },
      { label: '⧉ Duplicate', run: () => app.duplicate(p) },
      { label: '🔗 Copy [[link]]', run: () => { navigator.clipboard && navigator.clipboard.writeText(`[[${p.title}]]`); S.toast('Link copied'); } },
      { label: '↰ Move to…', run: () => movePage(p) },
      '-',
      { label: '🗑 Move to trash', danger: true, run: () => app.trash(p) },
    ]);
  }
  async function movePage(p) {
    const target = await S.pickPage(`Move “${p.title}” under…`, (x) => x.id !== p.id, { extra: [{ icon: '⌂', label: 'Top level (no parent)', value: null }] });
    if (target === undefined) return;
    if (target) for (let a = target; a; a = a.parentId && S.pages.get(a.parentId)) if (a.id === p.id) { S.toast('Can’t move a page inside itself'); return; }
    p.parentId = target ? target.id : null;
    if (target) { S.state.expanded.add(target.id); saveExpanded(); }
    await S.db.putPage(p);
    app.refresh();
  }

  function renderSidebar() {
    const all = S.livePages();
    const sorter = S.state.treeSort === 'updated' ? (a, b) => b.updated - a.updated : (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true });
    const kids = new Map();
    const ids = new Set(all.map((p) => p.id));
    const roots = [], daily = [], templates = [];
    for (const p of all) {
      if (p.parentId && ids.has(p.parentId)) (kids.get(p.parentId) || kids.set(p.parentId, []).get(p.parentId)).push(p);
      else if (p.type === 'daily') daily.push(p);
      else if (p.type === 'template') templates.push(p);
      else roots.push(p);
    }
    for (const arr of kids.values()) arr.sort(sorter);
    roots.sort(sorter);
    const tree = $('sb-tree');
    tree.innerHTML = '';
    for (const p of roots) tree.append(...treeItem(p, kids, 0));
    const group = (key, label, list) => {
      if (!list.length) return;
      const open = S.state.expanded.has(key);
      tree.append(h('div.tree-row.group', { style: { paddingLeft: '6px' } },
        h('button.caret', { onclick: () => { open ? S.state.expanded.delete(key) : S.state.expanded.add(key); saveExpanded(); renderSidebar(); } }, open ? '▾' : '▸'),
        h('span.tree-link', { onclick: () => { open ? S.state.expanded.delete(key) : S.state.expanded.add(key); saveExpanded(); renderSidebar(); } }, label, h('span.count', ' ' + list.length))));
      if (open) for (const p of list.sort((a, b) => key === '__daily' ? b.title.localeCompare(a.title) : a.title.localeCompare(b.title))) tree.append(...treeItem(p, kids, 1));
    };
    group('__daily', '📅 Daily notes', daily);
    group('__tpl', '🧩 Templates', templates);
    if (!all.length) tree.append(h('div.muted.small.pad', 'No pages yet.'));

    const favs = all.filter((p) => p.favorite).sort((a, b) => a.title.localeCompare(b.title));
    $('sb-favorites-wrap').hidden = !favs.length;
    $('sb-favorites').innerHTML = '';
    for (const p of favs) $('sb-favorites').append(h('a.fav' + (S.state.current === p.id ? '.active' : ''), { href: '#/page/' + p.id }, h('span.ic', S.pageIcon(p)), h('span.tt', p.title)));

    const tags = S.allTags().slice(0, 40);
    $('sb-tags').innerHTML = '';
    for (const [t, n] of tags) $('sb-tags').append(h('a.tag', { href: '#/tag/' + encodeURIComponent(t), title: n + ' pages' }, '#' + t));
    if (!tags.length) $('sb-tags').append(h('span.muted.small', 'Type #tag in a note'));

    document.querySelectorAll('.sb-nav a[data-nav]').forEach((a) => a.classList.toggle('active', location.hash.startsWith(a.getAttribute('href')) && !(a.dataset.nav === 'db' && location.hash.startsWith('#/db/book')) ));
  }

  /* ---------- topbar ---------- */
  function renderTopbar() {
    const crumbs = $('crumbs'), act = $('top-actions');
    crumbs.innerHTML = ''; act.innerHTML = '';
    const p = S.state.current && S.pages.get(S.state.current);
    if (!p) { crumbs.append(h('span.crumb', S.state.title || '')); return; }
    const chain = [];
    for (let a = p; a; a = a.parentId && S.pages.get(a.parentId)) { chain.unshift(a); if (chain.length > 8) break; }
    chain.forEach((c, i) => {
      if (i) crumbs.append(h('span.sep', '/'));
      crumbs.append(h('a.crumb', { href: '#/page/' + c.id }, S.pageIcon(c) + ' ' + c.title));
    });
    if (p.type !== 'canvas') {
      act.append(h('div.segmented.modes', [['edit', '✎ Edit'], ['split', '◧ Split'], ['read', '👁 Read']].map(([m, l]) =>
        h('button.seg' + (S.state.mode === m ? '.on' : ''), { onclick: () => app.setMode(m), title: 'Ctrl+E cycles modes' }, l))));
    }
    act.append(h('button.icon-btn' + (p.favorite ? '.on' : ''), { title: p.favorite ? 'Remove from favorites' : 'Add to favorites', onclick: () => app.toggleFav(p) }, p.favorite ? '★' : '☆'));
    act.append(h('button.icon-btn', { title: 'Page options', onclick: (e) => { const r = e.target.getBoundingClientRect(); pageMenu(p, r.left - 150, r.bottom + 4); } }, '⋯'));
  }

  function renderRight() {
    const p = S.state.current && S.pages.get(S.state.current);
    S.renderRightPanel($('rightpanel'), p && !p.deleted ? p : null);
  }

  function layout() {
    $('app').classList.toggle('no-sidebar', !S.state.sidebar);
    $('app').classList.toggle('no-right', !S.state.right || !S.state.current);
    $('toggle-right').hidden = !S.state.current;
  }

  /* ---------- router ---------- */
  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path, qs] = raw.split('?');
    const params = Object.fromEntries(new URLSearchParams(qs || ''));
    return { parts: path.split('/').map(decodeURIComponent), params };
  }

  async function route() {
    if (view && view.destroy) view.destroy();
    view = null;
    S.closeMenu();
    const { parts, params } = parseHash();
    const [r, arg] = parts;
    const host = $('view');
    host.innerHTML = '';
    host.scrollTop = 0;
    host.className = '';
    S.state.current = null;
    S.state.params = params;
    S.state.title = '';
    if (innerWidth < 760) { S.state.sidebar = false; }

    if (r === 'page' && S.pages.has(arg) && !S.pages.get(arg).deleted) {
      const p = S.pages.get(arg);
      S.state.current = p.id;
      host.className = 'v-page' + (p.type === 'canvas' ? ' v-canvas' : '');
      view = new S.PageView(host, p, params);
      if (params.new) history.replaceState(null, '', '#/page/' + p.id);
      document.title = p.title + ' · Synapse';
      localStorage.setItem('lastPage', p.id);
      const recent = JSON.parse(localStorage.getItem('recent') || '[]').filter((x) => x !== p.id);
      recent.unshift(p.id);
      localStorage.setItem('recent', JSON.stringify(recent.slice(0, 20)));
    } else if (r === 'graph') {
      S.state.title = '🕸️ Graph view';
      host.className = 'v-graph';
      view = graphView(host);
      document.title = 'Graph · Synapse';
    } else if (r === 'db') {
      S.state.title = '🗂️ Databases';
      S.renderDatabaseView(host, arg || 'all', (type) => app.createPage({ type }));
      document.title = 'Databases · Synapse';
    } else if (r === 'tag') {
      S.state.title = '#' + arg;
      tagView(host, arg);
      document.title = '#' + arg + ' · Synapse';
    } else if (r === 'search') {
      S.state.title = '🔎 Search';
      searchView(host, params.q || '');
      document.title = 'Search · Synapse';
    } else if (r === 'trash') {
      S.state.title = '🗑️ Trash';
      trashView(host);
    } else {
      if (r === 'page') S.toast('That page no longer exists');
      S.state.title = '🏠 Home';
      homeView(host);
      document.title = 'Synapse';
    }
    layout();
    renderSidebar();
    renderTopbar();
    if (S.state.current && S.state.right) renderRight();
    else { $('rightpanel').innerHTML = ''; if (S.rpGraph) { S.rpGraph.destroy(); S.rpGraph = null; } }
  }

  /* ---------- views ---------- */
  function homeView(host) {
    const all = S.livePages();
    const notes = all.filter((p) => p.type !== 'template');
    const linkCount = [...S.linkIndex.out.values()].reduce((s, l) => s + l.filter((x) => x.to).length, 0);
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const recentIds = JSON.parse(localStorage.getItem('recent') || '[]').filter((id) => S.pages.has(id) && !S.pages.get(id).deleted);
    const recent = [...new Set([...recentIds, ...notes.sort((a, b) => b.updated - a.updated).map((p) => p.id)])].slice(0, 8).map((id) => S.pages.get(id));

    // open tasks across the vault
    const tasks = [];
    for (const p of notes) {
      if (p.type === 'canvas') continue;
      p.content.split('\n').forEach((l, i) => { const m = l.match(/^\s*[-*+] \[ \] (.+)$/); if (m && m[1].trim()) tasks.push({ p, i, text: m[1] }); });
    }
    const inbox = S.queryPages('tag:inbox').slice(0, 8);
    const orphans = notes.filter((p) => p.type !== 'daily' && !S.backlinks(p.id).length && !(S.linkIndex.out.get(p.id) || []).length).slice(0, 6);
    const pick = notes.filter((p) => p.type !== 'daily');
    const resurf = pick.length ? pick[Math.floor(Math.random() * pick.length)] : null;

    host.append(h('div.page-wide.home',
      h('h1.view-title', greet + ' 👋'),
      h('div.stats',
        stat(notes.length, 'pages'), stat(linkCount, 'links'), stat(S.allTags().length, 'tags'),
        stat(notes.filter((p) => p.type === 'book').length, 'books'), stat(tasks.length, 'open tasks')),
      h('div.quick',
        h('button.btn.primary', { onclick: () => app.createPage() }, '＋ New page'),
        h('button.btn', { onclick: app.dailyNote }, '📅 Today’s note'),
        h('button.btn', { onclick: () => app.createPage({ type: 'book', title: 'New book' }) }, '📚 Add a book'),
        h('button.btn', { onclick: () => app.createPage({ type: 'canvas', title: 'New diagram' }) }, '◇ New diagram'),
        h('button.btn', { onclick: app.newFromTemplate }, '🧩 From template'),
        h('button.btn', { onclick: () => { location.hash = '#/graph'; } }, '🕸️ Graph')),
      h('h2', 'Jump back in'),
      h('div.cards', recent.map((p) => h('a.card', { href: '#/page/' + p.id },
        p.cover ? h('div.card-cover', { 'data-att': p.cover }) : null,
        h('div.card-title', h('span.ic', S.pageIcon(p)), p.title),
        h('div.card-ex', p.type === 'canvas' ? `◇ Diagram · ${(p.canvas && p.canvas.nodes.length) || 0} cards` : S.excerpt(p.content, 110)),
        h('div.card-meta', S.ago(p.updated))))),
      h('div.home-grid',
        h('div.panel', h('h3', '☑ Open tasks'),
          tasks.length ? h('div', tasks.slice(0, 12).map((t) => h('label.task-row',
            h('input', { type: 'checkbox', onchange: async () => {
              const lines = t.p.content.split('\n'); lines[t.i] = lines[t.i].replace('[ ]', '[x]'); t.p.content = lines.join('\n'); t.p.updated = Date.now();
              await S.db.putPage(t.p); S.toast('Done ✓'); route();
            } }),
            h('span', { html: S.inlineMD(t.text) }), h('a.muted.small', { href: '#/page/' + t.p.id }, ' — ' + t.p.title)))) : h('p.muted', 'No open tasks. 🎉')),
        h('div.panel', h('h3', '✨ Resurface'),
          resurf ? h('a.resurf', { href: '#/page/' + resurf.id }, h('div.card-title', S.pageIcon(resurf) + ' ' + resurf.title), h('div.card-ex', S.excerpt(resurf.content, 220))) : h('p.muted', 'Write some notes first.'),
          h('button.btn.sm', { onclick: () => route() }, '↻ Another')),
        h('div.panel', h('h3', '📥 Inbox ', h('span.muted.small', '#inbox')),
          inbox.length ? h('ul', inbox.map((p) => h('li', h('a', { href: '#/page/' + p.id }, S.pageIcon(p) + ' ' + p.title)))) : h('p.muted', 'Tag notes with #inbox to process them later.')),
        h('div.panel', h('h3', '🏝 Orphans ', h('span.muted.small', 'no links in or out')),
          orphans.length ? h('ul', orphans.map((p) => h('li', h('a', { href: '#/page/' + p.id }, S.pageIcon(p) + ' ' + p.title)))) : h('p.muted', 'Every note is connected. Nice!')))));
    S.hydrateImages(host);
    function stat(n, l) { return h('div.stat', h('b', String(n)), h('span', l)); }
  }

  function graphView(host) {
    const saved = JSON.parse(localStorage.getItem('graphSet') || '{}');
    const settings = Object.assign({ tags: false, ghosts: true, orphans: true, hierarchy: false, daily: true, repel: 1, linkDist: 1 }, saved);
    const box = h('div.graph-host');
    const tip = h('div.graph-tip', { hidden: true });
    host.append(box, tip);
    const g = new S.Graph(box, {
      settings,
      onOpen: (n) => {
        if (n.page) location.hash = '#/page/' + n.page.id;
        else if (n.kind === 'tag') location.hash = '#/tag/' + encodeURIComponent(n.id.slice(4));
        else if (n.kind === 'ghost') app.openTitle(n.label);
      },
    });
    g.onHover = (n) => {
      if (!n) { tip.hidden = true; return; }
      tip.hidden = false;
      tip.innerHTML = '';
      tip.append(h('b', n.kind === 'tag' ? n.label : (n.page ? S.pageIcon(n.page) + ' ' : '') + n.label),
        h('div.small.muted', n.kind === 'ghost' ? 'Not created yet — click to create' : n.kind === 'tag' ? 'Tag' : `${(S.TYPES[n.kind] || {}).label || ''} · ${g.nbrs.get(n.id).size} connections`),
        n.page && n.page.type !== 'canvas' ? h('div.small', S.excerpt(n.page.content, 140)) : null);
    };
    const save = () => { const { search, types, ...rest } = g.set; localStorage.setItem('graphSet', JSON.stringify(rest)); };
    const toggle = (key, label) => h('label.switch', h('input', { type: 'checkbox', checked: !!settings[key], onchange: (e) => { g.update({ [key]: e.target.checked }); save(); } }), label);
    const slider = (key, label, min, max) => h('label.slider', label, h('input', { type: 'range', min, max, step: 0.1, value: settings[key], oninput: (e) => { g.set[key] = +e.target.value; g.alpha = 0.8; save(); } }));
    const search = h('input.input', { placeholder: 'Highlight…', oninput: (e) => { g.set.search = e.target.value; g.applySearch(); } });
    const types = new Set(Object.keys(S.TYPES));
    const legend = h('div.legend', Object.entries(S.TYPES).filter(([k]) => k !== 'template').map(([k, t]) => h('button.leg', {
      title: 'Show/hide ' + t.label, onclick: (e) => { types.has(k) ? types.delete(k) : types.add(k); e.currentTarget.classList.toggle('off', !types.has(k)); g.update({ types: new Set(types) }); },
    }, h('i', { style: { background: t.color } }), t.label)), h('span.leg', h('i.ghost'), 'Not created'), h('span.leg', h('i', { style: { background: '#22c55e' } }), 'Tag'));
    const panel = h('div.graph-panel', search,
      toggle('tags', 'Tags as nodes'), toggle('ghosts', 'Unresolved links'), toggle('orphans', 'Orphans'), toggle('hierarchy', 'Parent → child'), toggle('daily', 'Daily notes'),
      slider('repel', 'Repel', 0.2, 3), slider('linkDist', 'Link distance', 0.3, 3),
      h('div.row', h('button.btn.sm', { onclick: () => g.fit() }, '⤢ Fit'), h('button.btn.sm', { onclick: () => { g.alpha = 1; g.nodes.forEach((n) => { n.x = (Math.random() - 0.5) * 600; n.y = (Math.random() - 0.5) * 600; }); setTimeout(() => g.fit(), 1200); } }, '↻ Re-layout')),
      legend,
      h('div.small.muted', 'Click a node to open · drag to move · scroll to zoom'));
    host.append(panel);
    return { destroy: () => g.destroy() };
  }

  function tagView(host, tag) {
    const pages = S.queryPages('tag:' + tag);
    const body = h('div');
    const related = new Map();
    for (const p of pages) for (const t of S.pageTags(p.id)) if (t !== tag) related.set(t, (related.get(t) || 0) + 1);
    host.append(h('div.page-wide', h('h1.view-title', '#' + tag), h('p.muted', `${pages.length} page${pages.length === 1 ? '' : 's'}`),
      related.size ? h('div.tag-cloud', h('span.muted.small', 'Related: '), [...related].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t]) => h('a.tag', { href: '#/tag/' + encodeURIComponent(t) }, '#' + t))) : null,
      body));
    S.renderTable(body, pages, [['title', 'Name'], ['type', 'Type'], ['tags', 'Tags'], ['updated', 'Updated']]);
  }

  function searchView(host, q) {
    const input = h('input.input.big', { value: q, placeholder: 'Search every note… (use "quotes" for exact phrases)' });
    const res = h('div.search-results');
    host.append(h('div.page-wide', h('h1.view-title', '🔎 Search'), input, res));
    const run = () => {
      const query = input.value.trim();
      history.replaceState(null, '', '#/search' + (query ? '?q=' + encodeURIComponent(query) : ''));
      res.innerHTML = '';
      if (!query) return;
      const terms = (query.match(/"[^"]+"|\S+/g) || []).map((t) => t.replace(/"/g, '').toLowerCase());
      const hits = [];
      for (const p of S.livePages()) {
        const text = S.pageText(p);
        const hay = (p.title + '\n' + text).toLowerCase();
        if (!terms.every((t) => hay.includes(t))) continue;
        let score = terms.reduce((s, t) => s + (p.title.toLowerCase().includes(t) ? 10 : 0) + hay.split(t).length - 1, 0);
        const lines = text.split('\n').filter((l) => terms.some((t) => l.toLowerCase().includes(t))).slice(0, 3);
        hits.push({ p, score, lines });
      }
      hits.sort((a, b) => b.score - a.score);
      res.append(h('div.muted.small', `${hits.length} result${hits.length === 1 ? '' : 's'}`));
      const mark = (s) => { let out = S.esc(s.length > 240 ? s.slice(0, 240) + '…' : s); for (const t of terms) out = out.replace(new RegExp(S.esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`); return out; };
      for (const { p, lines } of hits.slice(0, 100)) {
        res.append(h('a.search-hit', { href: '#/page/' + p.id }, h('div.card-title', { html: S.esc(S.pageIcon(p)) + ' ' + mark(p.title) }),
          lines.map((l) => h('div.hit-line', { html: mark(l.trim()) }))));
      }
    };
    input.addEventListener('input', S.debounce(run, 150));
    setTimeout(() => input.focus(), 10);
    run();
  }

  function trashView(host) {
    const del = [...S.pages.values()].filter((p) => p.deleted).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
    const list = h('div.trash-list');
    host.append(h('div.page-wide', h('h1.view-title', '🗑️ Trash'),
      h('div.row.between', h('p.muted', 'Restore pages or delete them forever.'),
        del.length ? h('button.btn.danger', { onclick: async () => {
          if (!(await S.confirm('Empty trash?', `Permanently delete ${del.length} page(s)? This cannot be undone.`, 'Delete forever'))) return;
          for (const p of del) await S.db.deletePageHard(p.id);
          route();
        } }, 'Empty trash') : null),
      list));
    if (!del.length) list.append(h('div.empty', 'Trash is empty.'));
    for (const p of del) list.append(h('div.trash-row', h('span', S.pageIcon(p) + ' ' + p.title), h('span.muted.small', 'deleted ' + S.ago(p.deletedAt || p.updated)),
      h('button.btn.sm', { onclick: async () => { await app.restore(p); route(); } }, 'Restore'),
      h('button.btn.sm.danger', { onclick: async () => {
        if (!(await S.confirm('Delete forever?', `“${p.title}” will be permanently deleted. This cannot be undone.`, 'Delete forever'))) return;
        await S.db.deletePageHard(p.id); route();
      } }, 'Delete')));
  }

  /* ---------- command palette / page picker ---------- */
  const COMMANDS = [
    ['New page', '＋', () => app.createPage()],
    ['New diagram', '◇', () => app.createPage({ type: 'canvas', title: 'New diagram' })],
    ['New book', '📚', () => app.createPage({ type: 'book', title: 'New book' })],
    ['New page from template', '🧩', () => app.newFromTemplate()],
    ['Open today’s daily note', '📅', () => app.dailyNote()],
    ['Open graph view', '🕸️', () => { location.hash = '#/graph'; }],
    ['Open library', '📚', () => { location.hash = '#/db/book'; }],
    ['Open databases', '🗂️', () => { location.hash = '#/db/all'; }],
    ['Full-text search', '🔎', () => { location.hash = '#/search'; }],
    ['Open random note', '🎲', () => app.randomNote()],
    ['Toggle dark / light theme', '🌓', () => { const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches); localStorage.setItem('theme', dark ? 'light' : 'dark'); app.applyTheme(); }],
    ['Toggle sidebar', '☰', () => toggleSidebar()],
    ['Toggle connections panel', '◫', () => toggleRight()],
    ['Export backup (.json)', '💾', () => S.exportJSON()],
    ['Export as Markdown files', '⬇', async () => { const m = await S.exportMarkdown(); m && S.toast(m); }],
    ['Settings, import & export', '⚙️', () => openSettings()],
    ['Open trash', '🗑️', () => { location.hash = '#/trash'; }],
    ['Keyboard shortcuts', '⌨', () => shortcuts()],
  ];

  /**
   * Generic palette. mode 'go' (navigate/commands) or 'pick' (resolve a page).
   */
  function palette({ title, filter, pick, extra, initial = '' } = {}) {
    return new Promise((resolve) => {
      const input = h('input.pal-input', { placeholder: pick ? title : 'Search pages…   > commands   # tags', value: initial });
      const list = h('div.pal-list');
      let items = [], sel = 0, done = false;
      const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
      const m = S.modal(pick ? title : 'Go to…', [input, list], { onClose: () => { if (!done) { done = true; resolve(undefined); } } });
      m.box.classList.add('palette');
      const draw = () => {
        list.innerHTML = '';
        items.forEach((it, i) => list.append(h('div.pal-item' + (i === sel ? '.on' : ''), { onmousedown: (e) => { e.preventDefault(); it.run(); }, onmousemove: () => { if (sel !== i) { sel = i; draw(); } } },
          h('span.ic', it.icon), h('span.pal-label', it.label), it.hint ? h('span.pal-hint', it.hint) : null)));
        const on = list.querySelector('.on'); on && on.scrollIntoView({ block: 'nearest' });
      };
      const update = () => {
        const q = input.value;
        sel = 0;
        if (!pick && q.startsWith('>')) {
          const qq = q.slice(1).trim();
          items = COMMANDS.map(([l, ic, fn]) => ({ l, ic, fn, s: S.fuzzy(qq, l) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s)
            .map((x) => ({ icon: x.ic, label: x.l, run: () => { finish(); x.fn(); } }));
        } else if (!pick && q.startsWith('#')) {
          items = S.allTags().map(([t, n]) => ({ t, n, s: S.fuzzy(q.slice(1), t) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 30)
            .map((x) => ({ icon: '#', label: x.t, hint: x.n + ' pages', run: () => { finish(); location.hash = '#/tag/' + encodeURIComponent(x.t); } }));
        } else {
          const qt = q.trim();
          const recent = JSON.parse(localStorage.getItem('recent') || '[]');
          let pages = S.livePages().filter((p) => !filter || filter(p));
          pages = pages.map((p) => ({ p, s: qt ? Math.max(S.fuzzy(qt, p.title), S.fuzzy(qt, String(p.props.aliases || '')) - 50) : (20 - Math.min(20, recent.indexOf(p.id) < 0 ? 20 : recent.indexOf(p.id))) * 1e12 + p.updated }))
            .filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 40);
          items = (extra || []).map((e) => ({ icon: e.icon, label: e.label, run: () => finish(e.value) }));
          items.push(...pages.map(({ p }) => ({
            icon: S.pageIcon(p), label: p.title,
            hint: [p.parentId && S.pages.get(p.parentId) ? S.pages.get(p.parentId).title + ' /' : '', (S.TYPES[p.type] || {}).label].filter(Boolean).join(' '),
            run: () => { if (pick) finish(p); else { finish(); location.hash = '#/page/' + p.id; } },
          })));
          if (!pick && qt && !S.findByTitle(qt)) items.push({ icon: '＋', label: `Create “${qt}”`, hint: 'Shift+Enter', run: () => { finish(); app.createPage({ title: qt }); } });
          if (!pick && qt) items.push({ icon: '🔎', label: `Search notes for “${qt}”`, run: () => { finish(); location.hash = '#/search?q=' + encodeURIComponent(qt); } });
          if (!pick && !qt) items.push({ icon: '>', label: 'Type > for commands, # for tags', run: () => { input.value = '>'; update(); input.focus(); } });
        }
        draw();
      };
      input.addEventListener('input', update);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); draw(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
        else if (e.key === 'Enter') {
          e.preventDefault();
          if (e.shiftKey && !pick && input.value.trim()) { finish(); app.createPage({ title: input.value.trim() }); return; }
          items[sel] && items[sel].run();
        }
      });
      update();
      setTimeout(() => input.focus(), 10);
    });
  }
  S.pickPage = (title, filter, opts = {}) => palette({ title, filter, pick: true, extra: opts.extra }).then((v) => v === undefined && !opts.extra ? null : v);
  app.palette = palette;

  /* ---------- settings ---------- */
  async function openSettings() {
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
    const sel = (key, def, opts, onchange) => {
      const s = h('select', opts.map(([v, l]) => h('option', { value: v, selected: (localStorage.getItem(key) || def) === v }, l)));
      s.addEventListener('change', () => { localStorage.setItem(key, s.value); onchange && onchange(s.value); app.applyTheme(); });
      return s;
    };
    const pages = S.livePages().length;
    let m;
    const syncEl = syncSection({ close: () => m.close() });
    m = S.modal('Settings', [
      h('div.settings',
        h('h4', '☁ Sync across devices'),
        syncEl,
        h('h4', 'Appearance'),
        h('div.prop', h('label', 'Theme'), sel('theme', 'system', [['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']])),
        h('div.prop', h('label', 'Editor font size'), sel('fontSize', '16', [['14', 'Small'], ['16', 'Medium'], ['18', 'Large'], ['20', 'Extra large']])),
        h('div.prop', h('label', 'Page width'), sel('wide', '0', [['0', 'Readable'], ['1', 'Full width']])),
        h('h4', 'Your data'),
        h('p.small.muted', `${pages} pages stored in this browser${est ? ` · ${(est.usage / 1048576).toFixed(1)} MB used` : ''}. Synapse never sends your notes anywhere. Clearing browser data deletes them — export backups regularly.`),
        h('div.row.wrap',
          persisted ? h('span.pill.ok', '✓ Storage is persistent') : h('button.btn', { onclick: async () => { const ok = navigator.storage && navigator.storage.persist && await navigator.storage.persist(); S.toast(ok ? 'Storage marked persistent' : 'Browser declined — keep exporting backups'); m.close(); openSettings(); } }, '🔒 Make storage persistent')),
        h('div.row.wrap',
          h('button.btn.primary', { onclick: () => S.exportJSON() }, '💾 Export backup (.json)'),
          h('button.btn', { onclick: async () => { const msg = await S.exportMarkdown(); msg && S.toast(msg); } }, '⬇ Export Markdown (+ images, .canvas)')),
        h('div.row.wrap',
          h('button.btn', { onclick: async () => {
            const f = await S.pickFile('.json,application/json'); if (!f) return;
            const replace = await S.confirm('Import backup', 'Replace everything with this backup? Choose Cancel to merge it into your current vault instead.', 'Replace all');
            try { const n = await S.importJSON(f, replace); S.reindexAll(); m.close(); S.toast(`Imported ${n} pages`); route(); } catch (e) { S.toast('Import failed: ' + e.message, 4000); }
          } }, '📂 Import backup'),
          h('button.btn', { onclick: async () => {
            const fs = await S.pickFile('.md,.markdown,.txt', true); if (!fs || !fs.length) return;
            const n = await S.importMarkdownFiles(fs); S.reindexAll(); m.close(); S.toast(`Imported ${n} notes`); route();
          } }, '📝 Import Markdown files')),
        h('h4', 'Danger zone'),
        h('div.row.wrap',
          h('button.btn', { onclick: async () => { await S.seedVault(); S.reindexAll(); m.close(); S.toast('Sample pages added'); route(); } }, 'Add sample pages'),
          h('button.btn.danger', { onclick: async () => {
            if (!(await S.confirm('Delete everything?', 'This permanently deletes every page, image and diagram in this browser (sync is disconnected first, so your GitHub copy is untouched). Export a backup first! This cannot be undone.', 'Delete everything'))) return;
            if (S.sync.config()) S.sync.disconnect(); // never let a local wipe propagate to the cloud vault
            await S.db.clearAll(); S.reindexAll(); localStorage.removeItem('recent'); location.hash = '#/home'; route(); S.toast('Vault cleared');
          } }, 'Delete all data')),
        h('h4', 'About'),
        h('p.small.muted', 'Synapse — an offline second brain. Open-source, no dependencies, works without internet.'))]);
  }
  app.openSettings = openSettings;

  function shortcuts() {
    const rows = [['Ctrl/⌘ K or P', 'Search / jump to page'], ['Ctrl/⌘ Shift P', 'Command palette'], ['Ctrl/⌘ N', 'New page'], ['Ctrl/⌘ E', 'Cycle Edit / Split / Read'],
      ['Ctrl/⌘ G', 'Graph view'], ['Ctrl/⌘ D (editor: Alt+D)', 'Today’s note'], ['Ctrl/⌘ \\', 'Toggle sidebar'], ['Ctrl/⌘ B / I', 'Bold / italic'], ['Ctrl/⌘ Shift H', 'Highlight'],
      ['Ctrl/⌘ Enter', 'Toggle to-do'], ['Tab / Shift Tab', 'Indent / outdent'], ['/', 'Block menu'], ['[[', 'Link a page (then # for a heading, @ for a page number)'],
      ['Canvas: double-click', 'New card'], ['Canvas: drag edge dot', 'Connect cards'], ['Canvas: Del, Ctrl+D, Ctrl+A', 'Delete, duplicate, select all']];
    S.modal('Keyboard shortcuts', h('table.kbd-table', rows.map(([k, d]) => h('tr', h('td', h('kbd', k)), h('td', d)))));
  }

  /* ---------- layout toggles ---------- */
  function toggleSidebar() { S.state.sidebar = !S.state.sidebar; localStorage.setItem('sidebar', S.state.sidebar ? '1' : '0'); layout(); }
  function toggleRight() { S.state.right = !S.state.right; localStorage.setItem('right', S.state.right ? '1' : '0'); layout(); if (S.state.right) renderRight(); }

  /* ---------- hover previews for links ---------- */
  let hoverT, hoverEl;
  function hoverPreview(a) {
    const p = S.findByTitle(a.dataset.target);
    if (!p || a.closest('.hover-pop')) return;
    hidePreview();
    hoverEl = h('div.hover-pop', h('div.embed-head', h('b', S.pageIcon(p) + ' ' + p.title), h('span.muted', (S.TYPES[p.type] || {}).label || '')));
    const body = h('div.md');
    hoverEl.append(body);
    if (p.type === 'canvas') { const box = h('div.embed-canvas', { style: { height: '220px' } }); body.append(box); document.body.append(hoverEl); new S.CanvasBoard(box, p, { readOnly: true }); }
    else {
      let text = p.content;
      if (a.dataset.heading) { const i = text.toLowerCase().indexOf(a.dataset.heading.toLowerCase()); if (i > 0) text = text.slice(text.lastIndexOf('\n', i) + 1); }
      S.renderPreview(body, text.slice(0, 1500), 2, p);
      document.body.append(hoverEl);
    }
    const r = a.getBoundingClientRect();
    const pr = hoverEl.getBoundingClientRect();
    hoverEl.style.left = Math.max(8, Math.min(r.left, innerWidth - pr.width - 8)) + 'px';
    hoverEl.style.top = (r.bottom + pr.height + 8 > innerHeight ? Math.max(8, r.top - pr.height - 6) : r.bottom + 6) + 'px';
    hoverEl.addEventListener('mouseleave', hidePreview);
  }
  function hidePreview() { if (hoverEl) { hoverEl.remove(); hoverEl = null; } }

  /* ---------- global events ---------- */
  function bindGlobal() {
    window.addEventListener('hashchange', route);
    $('open-palette').onclick = () => palette();
    $('new-page').onclick = () => app.createPage();
    $('new-canvas').onclick = () => app.createPage({ type: 'canvas', title: 'New diagram' });
    $('nav-daily').onclick = (e) => { e.preventDefault(); app.dailyNote(); };
    $('open-settings').onclick = openSettings;
    $('sb-collapse').onclick = toggleSidebar;
    $('sb-show').onclick = toggleSidebar;
    $('toggle-right').onclick = toggleRight;
    $('sort-tree').onclick = () => { S.state.treeSort = S.state.treeSort === 'title' ? 'updated' : 'title'; localStorage.setItem('treeSort', S.state.treeSort); S.toast('Sorted by ' + (S.state.treeSort === 'title' ? 'name' : 'last edited')); renderSidebar(); };

    // drop on "Pages" header → move to top level
    const pagesTitle = $('sb-tree').previousElementSibling;
    pagesTitle.addEventListener('dragover', (e) => { e.preventDefault(); pagesTitle.classList.add('drop'); });
    pagesTitle.addEventListener('dragleave', () => pagesTitle.classList.remove('drop'));
    pagesTitle.addEventListener('drop', async (e) => {
      e.preventDefault(); pagesTitle.classList.remove('drop');
      const p = S.pages.get(e.dataTransfer.getData('text/synapse-page'));
      if (p) { p.parentId = null; await S.db.putPage(p); app.refresh(); }
    });

    document.addEventListener('click', (e) => {
      const a = e.target.closest('a.wikilink');
      if (a) {
        e.preventDefault();
        hidePreview();
        app.openTitle(a.dataset.target, { h: a.dataset.heading, loc: a.dataset.locator });
        return;
      }
      // close mobile sidebar after navigating
      if (innerWidth < 760 && S.state.sidebar && (e.target.closest('#sidebar a[href^="#/"]') || (e.target.closest('#main') && !e.target.closest('#sb-show')))) { S.state.sidebar = false; layout(); }
    });
    document.addEventListener('mouseover', (e) => {
      const a = e.target.closest && e.target.closest('a.wikilink:not(.ghost)');
      clearTimeout(hoverT);
      if (a) hoverT = setTimeout(() => hoverPreview(a), 450);
      else if (hoverEl && !e.target.closest('.hover-pop')) hoverT = setTimeout(hidePreview, 250);
    });

    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && e.shiftKey && k === 'p') { e.preventDefault(); palette({ initial: '>' }); return; }
      if (mod && (k === 'k' || k === 'p' || k === 'o')) { e.preventDefault(); palette(); return; }
      if (mod && k === 'n' && !e.shiftKey) { e.preventDefault(); app.createPage(); return; }
      if (mod && k === 'g') { e.preventDefault(); location.hash = '#/graph'; return; }
      if (mod && k === '\\') { e.preventDefault(); toggleSidebar(); return; }
      if (mod && k === 'e' && S.state.current) {
        e.preventDefault();
        const order = ['edit', 'split', 'read'];
        app.setMode(order[(order.indexOf(S.state.mode) + 1) % 3]);
        return;
      }
      const inField = e.target.closest && e.target.closest('input, textarea, select');
      if ((mod && k === 'd' && !inField && !e.target.closest('.cv')) || (e.altKey && k === 'd')) { e.preventDefault(); app.dailyNote(); }
      if (e.key === 'Escape' && hoverEl) hidePreview();
    });
    window.addEventListener('beforeunload', () => { if (view && view.save) view.save.flush(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && view && view.save) view.save.flush(); });
    window.addEventListener('resize', S.debounce(() => { if (view && view.autosize) view.autosize(); }, 200));
  }

  /* ---------- boot ---------- */
  async function boot() {
    app.applyTheme();
    try {
      const n = await S.db.open();
      if (!n && !localStorage.getItem('seeded')) {
        const w = await S.seedVault();
        localStorage.setItem('seeded', '1');
        if (!location.hash) location.hash = '#/page/' + w.id;
      }
    } catch (err) {
      console.error(err);
      $('view').innerHTML = `<div class="page-wide"><h1>Storage unavailable</h1><p>Synapse needs IndexedDB. Private/incognito windows or strict privacy settings may block it.</p><pre>${S.esc(err.message)}</pre></div>`;
      return;
    }
    S.reindexAll();
    bindGlobal();
    route();
    S.sync.listeners.add(renderSyncStatus);
    $('sync-status').onclick = () => S.sync.run({ force: true });
    setInterval(renderSyncStatus, 30000);
    S.sync.start();
    renderSyncStatus();
    if (/^https?:$/.test(location.protocol) && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  boot();
})(window.S);
