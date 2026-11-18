/* Synapse — page view: header, properties, editor/preview, embeds, right-hand connections panel. */
(function (S) {
  'use strict';
  const h = S.h;

  const PROP_DEFAULTS = {
    book: ['author', 'year', 'pages', 'status', 'rating', 'isbn'],
    source: ['author', 'url', 'status'],
    person: ['role', 'url'],
    project: ['status', 'due'],
    concept: [],
    note: [],
    daily: [],
    canvas: [],
    template: [],
  };

  /* ---------- preview rendering (shared by page view, embeds, hovers) ---------- */
  S.renderPreview = (el, text, depth = 0, page = null) => {
    el.innerHTML = S.md(text);
    S.hydrateImages(el);
    S.hydrateQueries(el);
    el.querySelectorAll('.embed').forEach((em) => renderEmbed(em, depth, page));
  };

  function sectionOf(text, heading) {
    const lines = text.split('\n');
    const want = S.slug(heading);
    let start = -1, level = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
      if (!m) continue;
      if (start < 0 && S.slug(m[2].trim()) === want) { start = i; level = m[1].length; continue; }
      if (start >= 0 && m[1].length <= level) return lines.slice(start, i).join('\n');
    }
    return start >= 0 ? lines.slice(start).join('\n') : null;
  }

  function renderEmbed(em, depth, fromPage) {
    const title = em.dataset.target;
    const p = S.findByTitle(title);
    em.innerHTML = '';
    if (!p) {
      em.classList.add('missing');
      em.append(h('span', '⧉ '), h('a.wikilink.ghost', { href: '#', 'data-target': title }, title), h('span.muted', ' — doesn’t exist yet. Click to create.'));
      return;
    }
    if (fromPage && p.id === fromPage.id) { em.append(h('span.muted', '(a page can’t embed itself)')); return; }
    em.append(h('div.embed-head', h('a', { href: '#/page/' + p.id }, S.pageIcon(p) + ' ' + p.title + (em.dataset.heading ? ' › ' + em.dataset.heading : '')), h('span.muted', 'embedded')));
    if (p.type === 'canvas') {
      const size = em.dataset.size && /^\d+$/.test(em.dataset.size) ? +em.dataset.size : 340;
      const box = h('div.embed-canvas', { style: { height: size + 'px' } });
      em.append(box);
      requestAnimationFrame(() => new S.CanvasBoard(box, p, { readOnly: true, onClick: () => { location.hash = '#/page/' + p.id; } }));
      return;
    }
    if (depth >= 2) { em.append(h('div.muted', 'Embed depth limit reached.')); return; }
    let text = p.content;
    if (em.dataset.heading) text = sectionOf(p.content, em.dataset.heading) ?? `*Heading “${em.dataset.heading}” not found.*`;
    const body = h('div.embed-body.md');
    em.append(body);
    S.renderPreview(body, text, depth + 1, p);
  }

  /* ---------- page view ---------- */
  S.PageView = class {
    constructor(host, page, params) {
      this.host = host;
      this.page = page;
      this.params = params || {};
      this.save = S.debounce(() => this.persist(), 500);
      this.renderPrev = S.debounce(() => this.updatePreview(), 250);
      this.build();
    }

    async persist() {
      const p = this.page;
      p.updated = Date.now();
      await S.db.putPage(p);
      S.indexPage(p);
      S.app.refreshSoon();
    }
    touch() { this.save(); }

    destroy() {
      this.save.flush && this.save.flush();
      this.ed && this.ed.destroy();
      this.board && this.board.destroy();
      this.renderPrev.cancel();
    }

    build() {
      const p = this.page;
      const host = this.host;
      host.innerHTML = '';
      const isCanvas = p.type === 'canvas';
      if (this.params.new && S.state.mode === 'read' && !this._modeFixed) { this._modeFixed = true; S.state.mode = 'edit'; localStorage.setItem('mode', 'edit'); }
      const wrap = h('div.page' + (isCanvas ? '.canvas-page' : '') + '.mode-' + S.state.mode);
      this.wrap = wrap;

      // cover
      if (p.cover && !isCanvas) {
        wrap.append(h('div.cover', { 'data-att': p.cover },
          h('div.cover-actions',
            h('button.btn.sm', { onclick: () => this.pickCover() }, 'Change cover'),
            h('button.btn.sm', { onclick: () => { p.cover = null; this.touch(); this.build(); } }, 'Remove'))));
      }
      // header
      const head = h('div.page-head');
      const hover = h('div.head-hover',
        !p.icon ? h('button.link-btn', { onclick: (e) => this.pickIcon(e) }, '☺ Add icon') : null,
        !p.cover && !isCanvas ? h('button.link-btn', { onclick: () => this.pickCover() }, '🖼 Add cover') : null,
        h('button.link-btn', { onclick: () => { this.propsOpen = !this.propsOpen; this.propsEl.hidden = !this.propsOpen; localStorage.setItem('propsOpen', this.propsOpen ? '1' : ''); } }, '☰ Properties'));
      const iconBtn = p.icon ? h('button.page-icon', { title: 'Change icon', onclick: (e) => this.pickIcon(e) }, p.icon) : null;
      const title = h('textarea.page-title', { rows: 1, placeholder: 'Untitled', spellcheck: false });
      title.value = p.title;
      const fitTitle = () => { title.style.height = 'auto'; title.style.height = title.scrollHeight + 'px'; };
      title.addEventListener('input', fitTitle);
      title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.ta ? this.ta.focus() : title.blur(); } });
      title.addEventListener('change', () => this.rename(title.value));
      title.addEventListener('blur', () => this.rename(title.value));
      this.titleEl = title;
      head.append(...[hover, iconBtn, title].filter(Boolean));
      wrap.append(head);
      requestAnimationFrame(fitTitle);

      // properties
      this.propsOpen = isCanvas ? localStorage.getItem('propsOpen') === '1' : (localStorage.getItem('propsOpen') !== '' || p.type !== 'note');
      this.propsEl = h('div.props');
      this.propsEl.hidden = !this.propsOpen;
      this.renderProps();
      wrap.append(this.propsEl);

      if (isCanvas) {
        const boardHost = h('div.board-host');
        wrap.append(boardHost);
        host.append(wrap);
        this.board = new S.CanvasBoard(boardHost, p, { onChange: () => { S.indexPage(p); this.touch(); } });
        S.hydrateImages(wrap);
        return;
      }

      // body: editor + preview
      const body = h('div.page-body');
      const ta = h('textarea.editor', { spellcheck: true, placeholder: 'Start writing…  Type / for blocks, [[ to link a page, paste images directly.' });
      ta.value = p.content;
      this.ta = ta;
      this.preview = h('div.preview.md');
      body.append(h('div.edit-pane', ta), this.preview);
      wrap.append(body);

      // sub-pages
      this.subEl = h('div.subpages');
      wrap.append(this.subEl);
      this.renderSubpages();

      host.append(wrap);
      S.hydrateImages(wrap);

      this.ed = S.Editor(ta, {
        page: p,
        onChange: (v) => { p.content = v; this.touch(); this.renderPrev(); this.autosize(); },
        onAction: (a, ed) => this.slashAction(a, ed),
      });
      this.updatePreview();
      requestAnimationFrame(() => this.autosize());

      // dblclick preview → jump to that line in the editor
      this.preview.addEventListener('dblclick', (e) => {
        if (e.target.closest('a, input, .embed, .query-block')) return;
        const lineEl = e.target.closest('[data-line]');
        if (S.state.mode === 'read') S.app.setMode('edit');
        if (lineEl) this.gotoLine(+lineEl.dataset.line);
      });
      // task toggles
      this.preview.addEventListener('change', (e) => {
        const cb = e.target;
        if (!cb.matches('input[type=checkbox][data-line]') || cb.closest('.embed')) return;
        const lines = p.content.split('\n');
        const i = +cb.dataset.line;
        lines[i] = cb.checked ? lines[i].replace(/\[ \]/, '[x]') : lines[i].replace(/\[[xX]\]/, '[ ]');
        p.content = lines.join('\n');
        ta.value = p.content;
        this.touch();
        this.updatePreview();
      });

      if (this.params.h) setTimeout(() => this.scrollToHeading(this.params.h), 50);
      if (this.params.new) { title.focus(); title.select(); }
    }

    autosize() {
      if (!this.ta || S.state.mode === 'split') { if (this.ta) this.ta.style.height = ''; return; }
      const y = window.scrollY, v = document.getElementById('view'), st = v.scrollTop;
      this.ta.style.height = 'auto';
      this.ta.style.height = Math.max(300, this.ta.scrollHeight + 40) + 'px';
      v.scrollTop = st; window.scrollTo(0, y);
    }

    updatePreview() {
      if (!this.preview) return;
      const st = this.preview.scrollTop;
      S.renderPreview(this.preview, this.page.content, 0, this.page);
      if (!this.page.content.trim()) this.preview.innerHTML = '<p class="muted">Nothing here yet — switch to Edit (Ctrl+E) or double-click to start writing.</p>';
      this.preview.scrollTop = st;
    }

    gotoLine(n) {
      const lines = this.ta.value.split('\n');
      let pos = 0;
      for (let i = 0; i < n && i < lines.length; i++) pos += lines[i].length + 1;
      this.ta.focus();
      this.ta.setSelectionRange(pos, pos + (lines[n] || '').length);
      const lh = parseFloat(getComputedStyle(this.ta).lineHeight) || 24;
      if (S.state.mode === 'split') this.ta.scrollTop = Math.max(0, n * lh - 120);
      else this.ta.getBoundingClientRect() && document.getElementById('view').scrollTo({ top: this.ta.offsetTop + n * lh - 200 });
    }

    scrollToHeading(slug) {
      const el = this.preview && this.preview.querySelector('#h-' + CSS.escape(slug));
      if (el && S.state.mode !== 'edit') { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
      else {
        const hs = S.headings(this.page.content);
        const lines = this.page.content.split('\n');
        const idx = lines.findIndex((l) => { const m = l.match(/^#{1,6}\s+(.*)$/); return m && S.slug(m[1].trim()) === slug; });
        if (idx >= 0 && hs.length) this.gotoLine(idx);
      }
    }

    async rename(raw) {
      const p = this.page;
      let t = raw.replace(/\s+/g, ' ').trim() || 'Untitled';
      t = t.replace(/[\[\]|#@]/g, '');
      if (t === p.title) { this.titleEl.value = t; return; }
      const clash = S.findByTitle(t);
      if (clash && clash.id !== p.id) { S.toast(`A page called “${t}” already exists`); this.titleEl.value = p.title; return; }
      const old = p.title;
      p.title = t;
      this.titleEl.value = t;
      const changed = S.renameLinks(old, t);
      for (const c of changed) if (c.id !== p.id) { c.updated = Date.now(); await S.db.putPage(c); }
      await S.db.putPage(p);
      S.reindexAll();
      if (changed.length) S.toast(`Updated links in ${changed.length} page${changed.length > 1 ? 's' : ''}`);
      S.app.refresh();
      document.title = t + ' · Synapse';
    }

    renderProps() {
      const p = this.page;
      const el = this.propsEl;
      el.innerHTML = '';
      const row = (label, input) => h('div.prop', h('label', label), input);
      const typeSel = h('select', { onchange: () => { p.type = typeSel.value; if (p.type === 'canvas' && !p.canvas) p.canvas = S.emptyCanvas(); this.touch(); this.build(); S.app.refresh(); } },
        Object.entries(S.TYPES).map(([k, t]) => h('option', { value: k, selected: p.type === k }, t.icon + ' ' + t.label)));
      el.append(row('Type', typeSel));
      const keys = [...new Set([...(PROP_DEFAULTS[p.type] || []), ...Object.keys(p.props).filter((k) => k !== 'tags')])];
      for (const k of keys) el.append(row(k, this.propInput(k)));
      const tagsIn = h('input', { value: p.props.tags || '', placeholder: 'comma, separated' });
      tagsIn.addEventListener('change', () => { p.props.tags = tagsIn.value; S.indexPage(p); this.touch(); });
      el.append(row('tags', tagsIn));
      const auto = S.pageTags(p.id);
      if (auto.length) el.append(row('', h('div', auto.map((t) => h('a.tag', { href: '#/tag/' + encodeURIComponent(t) }, '#' + t)))));
      el.append(h('div.prop', h('label'), h('button.link-btn', { onclick: async () => {
        const k = await S.prompt('New property name', '', 'e.g. publisher, source, mood');
        if (!k) return;
        const key = k.toLowerCase().replace(/[^\w-]/g, '');
        if (!key || key in p.props) return;
        p.props[key] = ''; this.touch(); this.renderProps();
      } }, '＋ Add property')));
      el.append(h('div.prop.meta', h('label'), h('span.muted', `Created ${S.fmtDate(p.created, true)} · Edited ${S.ago(p.updated)}`)));
    }

    propInput(k) {
      const p = this.page;
      let input;
      if (k === 'status') {
        input = h('select', h('option', { value: '' }, '—'), S.STATUSES.map((s) => h('option', { value: s, selected: p.props.status === s }, s)));
      } else if (k === 'rating') {
        input = h('div.stars-input', [1, 2, 3, 4, 5].map((n) => h('button', { class: n <= (+p.props.rating || 0) ? 'on' : '', title: n + ' star' + (n > 1 ? 's' : ''),
          onclick: () => { p.props.rating = String(+p.props.rating === n ? 0 : n); this.touch(); this.renderProps(); } }, '★')));
        return input;
      } else if (k === 'due') {
        input = h('input', { type: 'date', value: p.props.due || '' });
      } else {
        input = h('input', { value: p.props[k] || '', placeholder: 'Empty' });
      }
      input.addEventListener('change', () => { p.props[k] = input.value; this.touch(); });
      input.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        S.menu(e.clientX, e.clientY, [{ label: `Remove “${k}”`, danger: true, run: () => { delete p.props[k]; this.touch(); this.renderProps(); } }]);
      });
      return input;
    }

    renderSubpages() {
      const kids = S.livePages().filter((c) => c.parentId === this.page.id).sort((a, b) => a.title.localeCompare(b.title));
      this.subEl.innerHTML = '';
      this.subEl.append(h('div.sub-head', h('span', 'Sub-pages'),
        h('button.link-btn', { onclick: () => S.app.createPage({ parentId: this.page.id }) }, '＋ Add sub-page')));
      if (kids.length) this.subEl.append(h('div.sub-list', kids.map((c) => h('a.sub-item', { href: '#/page/' + c.id }, S.pageIcon(c) + ' ' + c.title))));
    }

    pickIcon(e) {
      const p = this.page;
      const grid = h('div.emoji-grid', S.EMOJI.map((em) => h('button', { onclick: () => { p.icon = em; m.close(); this.touch(); this.build(); S.app.refresh(); } }, em)));
      const custom = h('input.input', { placeholder: 'Or paste any emoji / character', maxlength: 4 });
      custom.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && custom.value.trim()) { p.icon = custom.value.trim(); m.close(); this.touch(); this.build(); S.app.refresh(); } });
      const m = S.modal('Choose an icon', [grid, custom, h('div.row.end', h('button.btn', { onclick: () => { p.icon = ''; m.close(); this.touch(); this.build(); S.app.refresh(); } }, 'Remove icon'))]);
    }

    async pickCover() {
      const f = await S.pickFile('image/*');
      if (!f) return;
      this.page.cover = await S.db.putAttachment(f, f.name);
      this.touch(); this.build();
    }

    async slashAction(a, ed) {
      const p = this.page;
      if (a === 'image') { const files = await S.pickFile('image/*', true); if (files && files.length) ed.addImages(files); }
      else if (a === 'date') ed.insert(S.isoDay());
      else if (a === 'cite') {
        const book = await S.pickPage('Cite which book or source?', (x) => x.type === 'book' || x.type === 'source');
        if (!book) return ta(ed);
        const loc = await S.prompt('Page number (or chapter, timestamp…)', '', 'e.g. 42 or 88-91');
        ed.insert(`[[${book.title}${loc ? '@' + loc.replace(/[\]|]/g, '') : ''}]]`);
      } else if (a === 'diagram') {
        const name = await S.prompt('Diagram name', p.title + ' diagram');
        if (!name) return ta(ed);
        const c = await S.app.createPage({ title: name, type: 'canvas', parentId: p.id, canvas: S.emptyCanvas() }, { open: false });
        ed.insert(`![[${c.title}]]\n`);
        S.toast('Diagram created — click its title to draw');
      } else if (a === 'subpage') {
        const name = await S.prompt('Sub-page title');
        if (!name) return ta(ed);
        const c = await S.app.createPage({ title: name, parentId: p.id }, { open: false });
        ed.insert(`[[${c.title}]]`);
        this.renderSubpages();
      } else if (a === 'template') {
        const t = await S.pickPage('Insert which template?', (x) => x.type === 'template');
        if (!t) return ta(ed);
        ed.insert(S.fillTemplate(t.content, p.title));
      }
      function ta(e) { e.ta.focus(); }
    }
  };

  S.fillTemplate = (text, title) => text
    .replace(/\{\{\s*date\s*\}\}/gi, S.isoDay())
    .replace(/\{\{\s*time\s*\}\}/gi, new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    .replace(/\{\{\s*title\s*\}\}/gi, title);

  /* ---------- right panel ---------- */
  S.renderRightPanel = (host, page, tab) => {
    host.innerHTML = '';
    if (S.rpGraph) { S.rpGraph.destroy(); S.rpGraph = null; }
    if (!page) { host.append(h('div.rp-empty.muted', 'Open a page to see its connections.')); return; }
    const tabs = [['links', 'Links'], ['outline', 'Outline'], ['graph', 'Local graph']];
    tab = tab || localStorage.getItem('rpTab') || 'links';
    host.append(h('div.rp-tabs', tabs.map(([k, l]) => h('button' + (k === tab ? '.on' : ''), { onclick: () => { localStorage.setItem('rpTab', k); S.renderRightPanel(host, page, k); } }, l))));
    const body = h('div.rp-body');
    host.append(body);

    if (tab === 'links') {
      const bl = S.backlinks(page.id);
      if (page.type === 'book' || page.type === 'source') {
        const cites = [];
        for (const b of bl) for (const hit of b.hits) if (hit.locator) cites.push({ from: b.from, loc: hit.locator, line: hit.line });
        cites.sort((a, b) => (parseFloat(a.loc) || 1e9) - (parseFloat(b.loc) || 1e9));
        body.append(h('div.rp-section', h('div.rp-title', `📖 Citations (${cites.length})`),
          cites.length ? cites.map((c) => h('a.cite-row' + (S.state.params && S.state.params.loc === c.loc ? '.hl' : ''), { href: '#/page/' + c.from.id },
            h('span.loc', S.locatorLabel(c.loc)), h('span', S.pageIcon(c.from) + ' ' + c.from.title))) :
            h('div.muted.small', 'Cite this with [[' + page.title + '@42]] from any note.')));
      }
      body.append(h('div.rp-section', h('div.rp-title', `↩ Backlinks (${bl.length})`),
        bl.length ? bl.map((b) => h('div.bl',
          h('a.bl-title', { href: '#/page/' + b.from.id }, S.pageIcon(b.from) + ' ' + b.from.title),
          [...new Map(b.hits.map((x) => [x.line, x])).values()].slice(0, 3).map((hit) => h('div.bl-ctx', { html: S.inlineMD(hit.line.length > 220 ? hit.line.slice(0, 220) + '…' : hit.line) })))) :
          h('div.muted.small', 'No pages link here yet.')));
      const out = (S.linkIndex.out.get(page.id) || []);
      const uniq = new Map();
      for (const l of out) uniq.set(l.to || 'ghost:' + l.title.toLowerCase(), l);
      body.append(h('div.rp-section', h('div.rp-title', `↪ Outgoing (${uniq.size})`),
        [...uniq.values()].map((l) => l.to ? h('a.out', { href: '#/page/' + l.to }, S.pageIcon(S.pages.get(l.to)) + ' ' + S.pages.get(l.to).title)
          : h('a.out.ghost.wikilink', { href: '#', 'data-target': l.title }, '＋ ' + l.title))));
      const um = S.unlinkedMentions(page);
      body.append(h('div.rp-section', h('div.rp-title', `💬 Unlinked mentions (${um.length})`),
        um.length ? um.slice(0, 20).map((u) => h('div.bl',
          h('div.row.between', h('a.bl-title', { href: '#/page/' + u.from.id }, S.pageIcon(u.from) + ' ' + u.from.title),
            h('button.btn.sm', { title: 'Turn the first mention into a link', onclick: () => S.app.linkMention(u.from, page) }, 'Link')),
          h('div.bl-ctx', u.line.slice(0, 200)))) : h('div.muted.small', 'No unlinked mentions.')));
    } else if (tab === 'outline') {
      const hs = S.headings(page.type === 'canvas' ? '' : page.content);
      body.append(hs.length ? h('div.outline', hs.map((x) => h('a', { href: '#/page/' + page.id + '?h=' + encodeURIComponent(x.slug), style: { paddingLeft: (x.level - 1) * 14 + 6 + 'px' } }, x.text)))
        : h('div.muted.small', 'Add headings (# Title) to build an outline.'));
      const words = (page.content.match(/\S+/g) || []).length;
      body.append(h('div.rp-section', h('div.rp-title', 'Info'),
        h('div.small.muted', `${words} words · ${page.content.length} characters`), h('div.small.muted', 'Created ' + S.fmtDate(page.created, true)), h('div.small.muted', 'Edited ' + S.fmtDate(page.updated, true))));
    } else {
      const depth = +(localStorage.getItem('rpDepth') || 1);
      const gh = h('div.rp-graph');
      body.append(h('div.row.between', h('span.small.muted', 'Depth'),
        h('div.segmented', [1, 2, 3].map((d) => h('button.seg' + (d === depth ? '.on' : ''), { onclick: () => { localStorage.setItem('rpDepth', d); S.renderRightPanel(host, page, 'graph'); } }, String(d))))), gh);
      requestAnimationFrame(() => {
        S.rpGraph = new S.Graph(gh, { focusId: page.id, depth, mini: true, settings: { ghosts: true, tags: false },
          onOpen: (n) => n.page ? (location.hash = '#/page/' + n.page.id) : n.kind === 'ghost' && S.app.openTitle(n.label) });
        setTimeout(() => S.rpGraph && S.rpGraph.fit(), 700);
      });
    }
  };
})(window.S);
