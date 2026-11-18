/* Synapse — wiki links, tags, backlinks index.
 *  [[Page]]  [[Page#Heading]]  [[Page|alias]]  [[Book@42]] (page-number citation)  ![[Page]] (embed)
 */
(function (S) {
  'use strict';

  // [[target#heading@locator|alias]]  — each part optional except target
  S.LINK_RE = /(!?)\[\[([^\[\]|#@\n]+?)(?:#([^\[\]|@\n]+?))?(?:@([^\[\]|\n]+?))?(?:\|([^\[\]\n]+?))?\]\]/g;
  S.TAG_RE = /(^|[\s(,;])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;

  /** Blank out fenced code + inline code so links/tags inside them are ignored (keeps offsets). */
  S.maskCode = (text) => text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]+`/g, (m) => ' '.repeat(m.length));

  S.parseLinks = (text) => {
    const out = [];
    const masked = S.maskCode(text || '');
    S.LINK_RE.lastIndex = 0;
    let m;
    while ((m = S.LINK_RE.exec(masked))) {
      out.push({
        embed: m[1] === '!', target: m[2].trim(),
        heading: m[3] ? m[3].trim() : null,
        locator: m[4] ? m[4].trim() : null,
        alias: m[5] ? m[5].trim() : null,
        index: m.index, length: m[0].length,
      });
    }
    return out;
  };

  S.parseTags = (text) => {
    const tags = new Set();
    const masked = S.maskCode(text || '').replace(/^#{1,6}\s/gm, '  ');
    S.TAG_RE.lastIndex = 0;
    let m;
    while ((m = S.TAG_RE.exec(masked))) tags.add(m[2].toLowerCase().replace(/\/$/, ''));
    return [...tags];
  };

  /* ---------- title index ---------- */
  let titleIdx = new Map();
  S.rebuildTitles = () => {
    titleIdx = new Map();
    for (const p of S.livePages()) {
      titleIdx.set(p.title.toLowerCase(), p);
      const al = p.props && p.props.aliases;
      if (al) String(al).split(',').map((a) => a.trim().toLowerCase()).filter(Boolean)
        .forEach((a) => { if (!titleIdx.has(a)) titleIdx.set(a, p); });
    }
  };
  S.findByTitle = (title) => titleIdx.get(String(title).trim().toLowerCase()) || null;

  /* ---------- link index ---------- */
  // out: pageId -> [{to (id|null), title, heading, locator, embed, line}]
  S.linkIndex = { out: new Map(), tags: new Map() };

  function lineAt(text, idx) {
    const s = text.lastIndexOf('\n', idx - 1) + 1;
    let e = text.indexOf('\n', idx);
    if (e < 0) e = text.length;
    return text.slice(s, e).trim();
  }

  S.pageText = (p) => {
    if (p.type !== 'canvas' || !p.canvas) return p.content || '';
    return (p.canvas.nodes || []).filter((n) => n.text).map((n) => n.text).join('\n\n') + '\n' + (p.content || '');
  };

  S.indexPage = (p) => {
    if (p.deleted) { S.linkIndex.out.delete(p.id); S.linkIndex.tags.delete(p.id); return; }
    const text = S.pageText(p);
    const links = S.parseLinks(text).map((l) => {
      const t = S.findByTitle(l.target);
      return { to: t ? t.id : null, title: l.target, heading: l.heading, locator: l.locator, embed: l.embed, line: lineAt(text, l.index) };
    });
    if (p.type === 'canvas' && p.canvas) {
      for (const n of p.canvas.nodes || []) {
        if (n.kind === 'page' && n.pageId && S.pages.has(n.pageId)) {
          links.push({ to: n.pageId, title: S.pages.get(n.pageId).title, heading: null, locator: null, embed: false, line: 'On diagram' });
        }
      }
    }
    S.linkIndex.out.set(p.id, links);
    const tags = new Set(S.parseTags(text));
    const pt = p.props && p.props.tags;
    if (pt) String(pt).split(',').map((t) => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean).forEach((t) => tags.add(t));
    S.linkIndex.tags.set(p.id, [...tags]);
  };

  S.reindexAll = () => {
    S.rebuildTitles();
    S.linkIndex.out.clear();
    S.linkIndex.tags.clear();
    for (const p of S.pages.values()) S.indexPage(p);
  };

  S.backlinks = (id) => {
    const res = [];
    for (const [from, links] of S.linkIndex.out) {
      if (from === id) continue;
      const hits = links.filter((l) => l.to === id);
      if (hits.length && S.pages.has(from) && !S.pages.get(from).deleted) res.push({ from: S.pages.get(from), hits });
    }
    return res.sort((a, b) => b.from.updated - a.from.updated);
  };

  S.unlinkedMentions = (page) => {
    const t = page.title.trim();
    if (t.length < 3) return [];
    const re = new RegExp('(^|[^\\p{L}\\p{N}])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'iu');
    const linked = new Set(S.backlinks(page.id).map((b) => b.from.id));
    const res = [];
    for (const p of S.livePages()) {
      if (p.id === page.id || linked.has(p.id) || p.type === 'template') continue;
      const text = S.maskCode(S.pageText(p)).replace(S.LINK_RE, (m) => ' '.repeat(m.length));
      const m = re.exec(text);
      if (m) res.push({ from: p, line: lineAt(S.pageText(p), m.index + m[1].length) });
    }
    return res;
  };

  S.allTags = () => {
    const counts = new Map();
    for (const [id, tags] of S.linkIndex.tags) {
      const p = S.pages.get(id);
      if (!p || p.deleted) continue;
      for (const t of tags) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  S.pageTags = (id) => S.linkIndex.tags.get(id) || [];

  /** Rewrite [[Old...]] → [[New...]] across the vault. Returns changed pages. */
  S.renameLinks = (oldTitle, newTitle) => {
    const changed = [];
    const esc = oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(!?\\[\\[)' + esc + '(?=[\\]|#@])', 'gi');
    for (const p of S.pages.values()) {
      let touched = false;
      if (p.content && re.test(p.content)) { re.lastIndex = 0; p.content = p.content.replace(re, '$1' + newTitle); touched = true; }
      re.lastIndex = 0;
      if (p.canvas) for (const n of p.canvas.nodes || []) {
        if (n.text && re.test(n.text)) { re.lastIndex = 0; n.text = n.text.replace(re, '$1' + newTitle); touched = true; }
        re.lastIndex = 0;
      }
      if (touched) changed.push(p);
    }
    return changed;
  };

  /** Headings of a page, for outline + [[Page#…]] autocomplete */
  S.headings = (text) => {
    const out = [];
    const masked = S.maskCode(text || '');
    const re = /^(#{1,6})\s+(.+)$/gm;
    let m;
    while ((m = re.exec(masked))) out.push({ level: m[1].length, text: m[2].trim(), slug: S.slug(m[2].trim()) });
    return out;
  };
})(window.S);
