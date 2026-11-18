/* Synapse — Notion-style databases (table / board / gallery) and inline ```query``` blocks. */
(function (S) {
  'use strict';

  /** Query language: type:book tag:ideas status:"In progress" links:"Page" sort:-updated limit:10 free text */
  S.queryPages = (q) => {
    const tokens = (q || '').match(/(-?\w+:"[^"]*"|-?\w+:\S+|#[\w\-/]+|"[^"]*"|\S+)/g) || [];
    const f = { types: [], tags: [], status: [], links: [], text: [], sort: '-updated', limit: 0, not: [] };
    for (let t of tokens) {
      const neg = t.startsWith('-') && t.includes(':');
      if (neg) t = t.slice(1);
      const m = t.match(/^(\w+):"?([^"]*)"?$/);
      if (t.startsWith('#')) f.tags.push(t.slice(1).toLowerCase());
      else if (m) {
        const [, k, v] = m;
        const key = k.toLowerCase();
        if (neg) f.not.push([key, v.toLowerCase()]);
        else if (key === 'type') f.types.push(v.toLowerCase());
        else if (key === 'tag') f.tags.push(v.replace(/^#/, '').toLowerCase());
        else if (key === 'status') f.status.push(v.toLowerCase());
        else if (key === 'links' || key === 'linksto') f.links.push(v);
        else if (key === 'sort') f.sort = v;
        else if (key === 'limit') f.limit = parseInt(v, 10) || 0;
        else f.text.push(t.toLowerCase());
      } else f.text.push(t.replace(/"/g, '').toLowerCase());
    }
    let res = S.livePages().filter((p) => p.type !== 'template');
    if (f.types.length) res = res.filter((p) => f.types.includes(p.type));
    if (f.tags.length) res = res.filter((p) => { const tg = S.pageTags(p.id); return f.tags.every((t) => tg.some((x) => x === t || x.startsWith(t + '/'))); });
    if (f.status.length) res = res.filter((p) => f.status.includes(String(p.props.status || '').toLowerCase()));
    for (const l of f.links) {
      const target = S.findByTitle(l);
      res = res.filter((p) => (S.linkIndex.out.get(p.id) || []).some((x) => target ? x.to === target.id : x.title.toLowerCase() === l.toLowerCase()));
    }
    for (const [k, v] of f.not) {
      if (k === 'type') res = res.filter((p) => p.type !== v);
      if (k === 'tag') res = res.filter((p) => !S.pageTags(p.id).includes(v.replace(/^#/, '')));
      if (k === 'status') res = res.filter((p) => String(p.props.status || '').toLowerCase() !== v);
    }
    if (f.text.length) res = res.filter((p) => { const hay = (p.title + '\n' + S.pageText(p) + '\n' + Object.values(p.props).join(' ')).toLowerCase(); return f.text.every((t) => hay.includes(t)); });
    const desc = f.sort.startsWith('-');
    const key = f.sort.replace(/^-/, '');
    res.sort((a, b) => cmp(val(a, key), val(b, key)) * (desc ? -1 : 1));
    if (f.limit) res = res.slice(0, f.limit);
    return res;
  };
  function val(p, key) {
    if (key === 'title') return p.title.toLowerCase();
    if (key === 'updated' || key === 'created') return p[key];
    if (key === 'type') return p.type;
    const v = p.props[key];
    return v == null || v === '' ? null : isNaN(+v) ? String(v).toLowerCase() : +v;
  }
  function cmp(a, b) { if (a === b) return 0; if (a == null) return 1; if (b == null) return -1; return a < b ? -1 : 1; }

  const COLS = {
    base: [['title', 'Name'], ['type', 'Type'], ['tags', 'Tags'], ['status', 'Status'], ['links', 'Links'], ['updated', 'Updated']],
    book: [['title', 'Title'], ['author', 'Author'], ['year', 'Year'], ['rating', 'Rating'], ['status', 'Status'], ['tags', 'Tags'], ['links', 'Cited by'], ['updated', 'Updated']],
    person: [['title', 'Name'], ['role', 'Role'], ['tags', 'Tags'], ['links', 'Links'], ['updated', 'Updated']],
    project: [['title', 'Project'], ['status', 'Status'], ['due', 'Due'], ['tags', 'Tags'], ['updated', 'Updated']],
    source: [['title', 'Title'], ['author', 'Author'], ['url', 'URL'], ['status', 'Status'], ['tags', 'Tags'], ['updated', 'Updated']],
  };

  function cell(p, key, editable) {
    switch (key) {
      case 'title': return S.h('td.title', S.h('a', { href: '#/page/' + p.id, draggable: true, ondragstart: (e) => e.dataTransfer.setData('text/synapse-page', p.id) }, S.h('span.ic', S.pageIcon(p)), p.title));
      case 'type': return S.h('td', S.h('span.pill.t-' + p.type, (S.TYPES[p.type] || {}).label || p.type));
      case 'tags': return S.h('td', S.pageTags(p.id).slice(0, 4).map((t) => S.h('a.tag', { href: '#/tag/' + encodeURIComponent(t) }, '#' + t)));
      case 'updated': return S.h('td.muted', S.ago(p.updated));
      case 'links': return S.h('td.num', String(S.backlinks(p.id).length));
      case 'rating': return S.h('td', p.props.rating ? '★'.repeat(+p.props.rating) + '☆'.repeat(Math.max(0, 5 - p.props.rating)) : '');
      case 'url': return S.h('td', p.props.url ? S.h('a.extlink', { href: p.props.url, target: '_blank', rel: 'noopener' }, p.props.url.replace(/^https?:\/\//, '').slice(0, 30)) : '');
      case 'status': {
        if (!editable) return S.h('td', p.props.status ? S.h('span.pill.status', p.props.status) : '');
        const sel = S.h('select.status-sel', { onchange: async () => { p.props.status = sel.value; p.updated = Date.now(); await S.db.putPage(p); } },
          S.h('option', { value: '' }, '—'), S.STATUSES.map((s) => S.h('option', { value: s, selected: p.props.status === s }, s)));
        return S.h('td', sel);
      }
      default: return S.h('td', String(p.props[key] || ''));
    }
  }

  S.renderTable = (host, pages, cols, opts = {}) => {
    let sortKey = opts.sortKey || null, desc = false;
    const draw = () => {
      host.innerHTML = '';
      let rows = pages.slice();
      if (sortKey) rows.sort((a, b) => cmp(sortKey === 'links' ? S.backlinks(a.id).length : val(a, sortKey), sortKey === 'links' ? S.backlinks(b.id).length : val(b, sortKey)) * (desc ? -1 : 1));
      const t = S.h('table.db-table',
        S.h('thead', S.h('tr', cols.map(([k, label]) => S.h('th', { onclick: () => { desc = sortKey === k ? !desc : false; sortKey = k; draw(); } }, label, sortKey === k ? (desc ? ' ↓' : ' ↑') : '')))),
        S.h('tbody', rows.map((p) => S.h('tr', cols.map(([k]) => cell(p, k, opts.editable))))));
      host.append(S.h('div.table-wrap', t));
      if (!rows.length) host.append(S.h('div.empty', 'Nothing here yet.'));
    };
    draw();
  };

  S.renderBoard = (host, pages, onChange) => {
    host.innerHTML = '';
    const board = S.h('div.board');
    const cols = ['', ...S.STATUSES];
    for (const st of cols) {
      const items = pages.filter((p) => (p.props.status || '') === st);
      const col = S.h('div.board-col', { 'data-status': st },
        S.h('div.board-head', S.h('span', st || 'No status'), S.h('span.count', String(items.length))));
      for (const p of items) {
        col.append(S.h('a.board-card', { href: '#/page/' + p.id, draggable: true, 'data-id': p.id,
          ondragstart: (e) => { e.dataTransfer.setData('text/synapse-page', p.id); e.dataTransfer.effectAllowed = 'move'; } },
          S.h('div.bc-title', S.h('span.ic', S.pageIcon(p)), p.title),
          p.props.author ? S.h('div.bc-sub', p.props.author) : null,
          S.h('div.bc-tags', S.pageTags(p.id).slice(0, 3).map((t) => S.h('span.tag', '#' + t)))));
      }
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
      col.addEventListener('dragleave', () => col.classList.remove('over'));
      col.addEventListener('drop', async (e) => {
        e.preventDefault(); col.classList.remove('over');
        const p = S.pages.get(e.dataTransfer.getData('text/synapse-page'));
        if (!p) return;
        p.props.status = st || undefined;
        if (!st) delete p.props.status;
        p.updated = Date.now();
        await S.db.putPage(p);
        onChange && onChange();
      });
      board.append(col);
    }
    host.append(board);
  };

  S.renderGallery = (host, pages) => {
    host.innerHTML = '';
    const g = S.h('div.gallery');
    for (const p of pages) {
      g.append(S.h('a.gcard', { href: '#/page/' + p.id, draggable: true, ondragstart: (e) => e.dataTransfer.setData('text/synapse-page', p.id) },
        p.cover ? S.h('div.gcover', { 'data-att': p.cover }) : S.h('div.gcover.noimg.t-' + p.type, S.h('span', S.pageIcon(p))),
        S.h('div.gbody', S.h('div.gtitle', p.title),
          p.props.author ? S.h('div.gsub', p.props.author + (p.props.year ? ' · ' + p.props.year : '')) : S.h('div.gsub', S.excerpt(p.content, 90)),
          p.props.rating ? S.h('div.stars', '★'.repeat(+p.props.rating)) : null)));
    }
    host.append(g);
    if (!pages.length) host.append(S.h('div.empty', 'Nothing here yet.'));
    S.hydrateImages(host);
  };

  /** Full database page (#/db/:type) */
  S.renderDatabaseView = (host, type, onNew) => {
    const key = 'db:' + type;
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    let layout = saved.layout || (type === 'book' ? 'gallery' : 'table');
    let filter = saved.filter || '';
    const types = ['all', ...Object.keys(S.TYPES).filter((t) => t !== 'template')];
    const title = type === 'book' ? '📚 Library' : type === 'all' ? '🗂️ All pages' : (S.TYPES[type] ? S.TYPES[type].icon + ' ' + S.TYPES[type].label + 's' : type);
    const body = S.h('div.db-body');
    const filterIn = S.h('input.input.db-filter', { value: filter, placeholder: 'Filter… e.g. tag:ideas status:"In progress" links:"Atomic Habits"' });
    const layoutBtns = ['table', 'board', 'gallery'].map((l) => S.h('button.seg' + (l === layout ? '.on' : ''), { onclick: () => { layout = l; persist(); render(); } },
      { table: '▦ Table', board: '▤ Board', gallery: '▣ Gallery' }[l]));
    const persist = () => localStorage.setItem(key, JSON.stringify({ layout, filter }));
    host.append(S.h('div.page-wide',
      S.h('h1.view-title', title),
      S.h('div.db-tabs', types.map((t) => S.h('a.db-tab' + (t === type ? '.on' : ''), { href: '#/db/' + t }, t === 'all' ? 'All' : S.TYPES[t].icon + ' ' + S.TYPES[t].label))),
      S.h('div.db-bar', filterIn, S.h('div.segmented', layoutBtns), S.h('button.btn.primary', { onclick: () => onNew(type === 'all' ? 'note' : type) }, '＋ New')),
      body));
    filterIn.addEventListener('input', S.debounce(() => { filter = filterIn.value; persist(); render(); }, 200));
    function render() {
      layoutBtns.forEach((b, i) => b.classList.toggle('on', ['table', 'board', 'gallery'][i] === layout));
      const pages = S.queryPages((type === 'all' ? '' : 'type:' + type + ' ') + filter + (type === 'all' ? ' -type:daily' : ''));
      if (layout === 'table') S.renderTable(body, pages, COLS[type] || COLS.base, { editable: true });
      else if (layout === 'board') S.renderBoard(body, pages, render);
      else S.renderGallery(body, pages);
    }
    render();
  };

  /** Inline ```query``` blocks inside notes */
  S.hydrateQueries = (root) => {
    root.querySelectorAll('.query-block').forEach((el) => {
      const q = el.dataset.q;
      const view = (q.match(/\bview:(\w+)/) || [])[1] || 'table';
      const pages = S.queryPages(q.replace(/\bview:\w+/, ''));
      const tm = q.match(/\btype:(\w+)/);
      el.innerHTML = '';
      el.append(S.h('div.qb-head', S.h('span', '🗂 ' + q.replace(/\n/g, ' ')), S.h('span.muted', pages.length + ' result' + (pages.length === 1 ? '' : 's'))));
      const body = S.h('div');
      el.append(body);
      if (view === 'list') body.append(S.h('ul', pages.map((p) => S.h('li', S.h('a', { href: '#/page/' + p.id }, S.pageIcon(p) + ' ' + p.title)))));
      else if (view === 'gallery') S.renderGallery(body, pages);
      else if (view === 'board') S.renderBoard(body, pages, () => S.hydrateQueries(root));
      else S.renderTable(body, pages, (tm && COLS[tm[1]]) || COLS.base.filter(([k]) => k !== 'links'));
    });
  };
})(window.S);
