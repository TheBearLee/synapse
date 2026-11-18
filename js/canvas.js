/* Synapse — infinite canvas for diagrams: cards, shapes, images, page cards and labelled arrows. */
(function (S) {
  'use strict';
  const COLORS = ['', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];
  const SVGNS = 'http://www.w3.org/2000/svg';

  S.emptyCanvas = () => ({ nodes: [], edges: [], view: { x: 0, y: 0, k: 1 } });

  S.CanvasBoard = class {
    constructor(host, page, opts = {}) {
      this.host = host;
      this.page = page;
      if (!page.canvas) page.canvas = S.emptyCanvas();
      this.data = page.canvas;
      this.ro = !!opts.readOnly;
      this.opts = opts;
      this.sel = new Set();
      this.root = S.h('div.cv' + (this.ro ? '.ro' : ''));
      this.vp = S.h('div.cv-viewport');
      this.world = S.h('div.cv-world');
      this.svg = document.createElementNS(SVGNS, 'svg');
      this.svg.classList.add('cv-edges');
      this.svg.innerHTML = '<defs><marker id="cv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker></defs>';
      this.world.append(this.svg);
      this.vp.append(this.world);
      this.root.append(this.vp);
      if (!this.ro) this.root.append(this.toolbar());
      host.append(this.root);
      this.view = this.ro ? { x: 0, y: 0, k: 1 } : Object.assign({ x: 0, y: 0, k: 1 }, this.data.view);
      this.render();
      if (this.ro) requestAnimationFrame(() => this.fit(true));
      else if (!this.data.nodes.length) this.hint();
      this.bind();
    }

    changed() { if (!this.ro) { this.data.view = { ...this.view }; this.opts.onChange && this.opts.onChange(); } }

    toolbar() {
      const tb = S.h('div.cv-toolbar');
      const b = (label, title, fn) => S.h('button.tb', { title, onclick: fn }, label);
      const center = () => this.toWorld(this.vp.getBoundingClientRect().left + this.vp.clientWidth / 2, this.vp.getBoundingClientRect().top + this.vp.clientHeight / 2);
      tb.append(
        b('📝 Text', 'Add text card (or double-click the canvas)', () => { const c = center(); this.addNode({ kind: 'text', x: c.x - 110, y: c.y - 50, text: '' }, true); }),
        b('📄 Page', 'Add a card for an existing page', async () => {
          const p = await S.pickPage('Add page to diagram'); if (!p) return;
          const c = center(); this.addNode({ kind: 'page', pageId: p.id, x: c.x - 130, y: c.y - 70, w: 260, h: 150 });
        }),
        b('🖼 Image', 'Add image', async () => {
          const f = await S.pickFile('image/*'); if (!f) return;
          const id = await S.db.putAttachment(f, f.name); const c = center();
          this.addNode({ kind: 'image', attId: id, x: c.x - 150, y: c.y - 100, w: 300, h: 200 });
        }),
        b('▭', 'Rectangle', () => { const c = center(); this.addNode({ kind: 'text', shape: 'rect', x: c.x - 80, y: c.y - 40, w: 160, h: 80, text: '' }, true); }),
        b('◯', 'Ellipse', () => { const c = center(); this.addNode({ kind: 'text', shape: 'ellipse', x: c.x - 80, y: c.y - 50, w: 160, h: 100, text: '' }, true); }),
        b('◇', 'Diamond (decision)', () => { const c = center(); this.addNode({ kind: 'text', shape: 'diamond', x: c.x - 90, y: c.y - 60, w: 180, h: 120, text: '' }, true); }),
        S.h('span.tb-sep'),
        ...COLORS.map((col) => S.h('button.swatch' + (col ? '.c-' + col : '.c-none'), { title: col ? 'Color: ' + col : 'No color', onclick: () => this.colorSel(col) })),
        S.h('span.tb-sep'),
        b('⤢', 'Zoom to fit', () => this.fit()),
        b('🗑', 'Delete selection (Del)', () => this.deleteSel()),
      );
      return tb;
    }

    hint() {
      this.hintEl = S.h('div.cv-hint', 'Double-click to add a card · drag from a card’s edge dot to connect · drop images or pages here · scroll to zoom, drag background to pan');
      this.root.append(this.hintEl);
    }

    /* ---------- model ops ---------- */
    addNode(n, edit) {
      n = Object.assign({ id: S.uid('n_'), w: 220, h: 100, color: '' }, n);
      this.data.nodes.push(n);
      if (this.hintEl) { this.hintEl.remove(); this.hintEl = null; }
      this.sel = new Set([n.id]);
      this.render();
      this.changed();
      if (edit) this.editNode(n);
      return n;
    }
    node(id) { return this.data.nodes.find((n) => n.id === id); }
    deleteSel() {
      if (!this.sel.size) return;
      this.data.nodes = this.data.nodes.filter((n) => !this.sel.has(n.id));
      this.data.edges = this.data.edges.filter((e) => !this.sel.has(e.id) && !this.sel.has(e.from) && !this.sel.has(e.to));
      this.sel.clear();
      this.render(); this.changed();
    }
    colorSel(c) {
      for (const n of this.data.nodes) if (this.sel.has(n.id)) n.color = c;
      for (const e of this.data.edges) if (this.sel.has(e.id)) e.color = c;
      this.render(); this.changed();
    }

    /* ---------- rendering ---------- */
    applyView() {
      this.world.style.transform = `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.k})`;
      this.vp.style.backgroundSize = `${24 * this.view.k}px ${24 * this.view.k}px`;
      this.vp.style.backgroundPosition = `${this.view.x}px ${this.view.y}px`;
    }

    render() {
      this.applyView();
      this.world.querySelectorAll('.cv-node').forEach((el) => el.remove());
      for (const n of this.data.nodes) this.world.append(this.nodeEl(n));
      this.renderEdges();
      S.hydrateImages(this.world);
    }

    nodeEl(n) {
      const el = S.h(`div.cv-node.k-${n.kind}${n.shape ? '.s-' + n.shape : ''}${n.color ? '.c-' + n.color : ''}${this.sel.has(n.id) ? '.sel' : ''}`,
        { 'data-id': n.id, style: { left: n.x + 'px', top: n.y + 'px', width: n.w + 'px', height: n.h + 'px' } });
      if (n.shape === 'diamond') el.append(S.h('div.diamond-bg', { html: '<svg viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points="50,1 99,50 50,99 1,50"/></svg>' }));
      if (n.kind === 'text') {
        el.append(S.h('div.cv-text.md', { html: n.text ? S.md(n.text) : (this.ro ? '' : '<span class="muted">Double-click to edit</span>') }));
      } else if (n.kind === 'page') {
        const p = S.pages.get(n.pageId);
        if (!p || p.deleted) el.append(S.h('div.cv-page-missing', 'Page was deleted'));
        else {
          el.append(S.h('div.cv-page-head', S.h('span', S.pageIcon(p)), S.h('a.cv-page-title', { href: '#/page/' + p.id }, p.title)),
            S.h('div.cv-page-body', p.type === 'canvas' ? '◇ Diagram' : S.excerpt(p.content, 260)));
        }
      } else if (n.kind === 'image') {
        el.append(S.h('img.cv-img', { 'data-att': n.attId, draggable: false, alt: '' }));
      }
      if (!this.ro) {
        for (const side of ['t', 'r', 'b', 'l']) el.append(S.h('div.cv-dot.d-' + side, { 'data-side': side, title: 'Drag to connect' }));
        el.append(S.h('div.cv-resize', { title: 'Resize' }));
      }
      return el;
    }

    anchor(n, side) {
      const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
      return ({ t: { x: cx, y: n.y }, b: { x: cx, y: n.y + n.h }, l: { x: n.x, y: cy }, r: { x: n.x + n.w, y: cy } })[side];
    }
    bestSides(a, b) {
      const dx = (b.x + b.w / 2) - (a.x + a.w / 2), dy = (b.y + b.h / 2) - (a.y + a.h / 2);
      if (Math.abs(dx) * (a.h + b.h) > Math.abs(dy) * (a.w + b.w)) return dx > 0 ? ['r', 'l'] : ['l', 'r'];
      return dy > 0 ? ['b', 't'] : ['t', 'b'];
    }
    edgePath(p1, s1, p2, s2) {
      const d = Math.max(40, Math.hypot(p2.x - p1.x, p2.y - p1.y) * 0.4);
      const off = { t: [0, -1], b: [0, 1], l: [-1, 0], r: [1, 0] };
      const c1 = { x: p1.x + off[s1][0] * d, y: p1.y + off[s1][1] * d };
      const c2 = { x: p2.x + (s2 ? off[s2][0] * d : 0), y: p2.y + (s2 ? off[s2][1] * d : 0) };
      return `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`;
    }

    renderEdges() {
      [...this.svg.querySelectorAll('g.edge')].forEach((g) => g.remove());
      this.world.querySelectorAll('.cv-elabel').forEach((l) => l.remove());
      for (const e of this.data.edges) {
        const a = this.node(e.from), b = this.node(e.to);
        if (!a || !b) continue;
        const [sa, sb] = this.bestSides(a, b);
        const p1 = this.anchor(a, e.fromSide || sa), p2 = this.anchor(b, e.toSide || sb);
        const d = this.edgePath(p1, e.fromSide || sa, p2, e.toSide || sb);
        const g = document.createElementNS(SVGNS, 'g');
        g.setAttribute('class', `edge${e.color ? ' c-' + e.color : ''}${this.sel.has(e.id) ? ' sel' : ''}`);
        g.dataset.id = e.id;
        g.innerHTML = `<path class="hit" d="${d}"/><path class="line" d="${d}" marker-end="url(#cv-arrow)"${e.bidir ? ' marker-start="url(#cv-arrow)"' : ''}/>`;
        this.svg.append(g);
        if (e.label) {
          const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
          this.world.append(S.h('div.cv-elabel', { 'data-id': e.id, style: { left: mid.x + 'px', top: mid.y + 'px' } }, e.label));
        }
      }
    }

    fit(silent) {
      const ns = this.data.nodes;
      const W = this.vp.clientWidth || this.host.clientWidth || 600, H = this.vp.clientHeight || this.host.clientHeight || 300;
      if (!ns.length) { this.view = { x: W / 2, y: H / 2, k: 1 }; this.applyView(); return; }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of ns) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h); }
      const pad = 40;
      const k = Math.min(this.ro ? 1 : 1.5, (W - pad * 2) / (x1 - x0), (H - pad * 2) / (y1 - y0));
      this.view = { k, x: W / 2 - ((x0 + x1) / 2) * k, y: H / 2 - ((y0 + y1) / 2) * k };
      this.applyView();
      if (!silent) this.changed();
    }

    toWorld(cx, cy) {
      const r = this.vp.getBoundingClientRect();
      return { x: (cx - r.left - this.view.x) / this.view.k, y: (cy - r.top - this.view.y) / this.view.k };
    }

    editNode(n) {
      const el = this.world.querySelector(`.cv-node[data-id="${n.id}"]`);
      if (!el || n.kind !== 'text') return;
      const box = el.querySelector('.cv-text');
      const ta = S.h('textarea.cv-edit', { value: n.text || '', placeholder: 'Type… [[links]] and **markdown** work' });
      ta.value = n.text || '';
      box.replaceWith(ta);
      el.classList.add('editing');
      const ed = S.Editor(ta, { page: this.page });
      ta.focus();
      ta.addEventListener('blur', () => {
        setTimeout(() => {
          if (ed.suggest.open) return ta.focus();
          n.text = ta.value; ed.destroy();
          this.render(); this.changed();
        }, 150);
      });
      ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') ta.blur(); e.stopPropagation(); });
      ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    }

    /* ---------- interaction ---------- */
    bind() {
      const vp = this.vp;
      if (this.ro) {
        vp.addEventListener('click', (e) => {
          const t = e.target.closest('.cv-page-title');
          if (t) return; // normal link
          if (this.opts.onClick) this.opts.onClick(e);
        });
        return;
      }
      let act = null;
      vp.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 && e.button !== 1) return;
        if (e.target.closest('textarea, a')) return;
        const nodeEl = e.target.closest('.cv-node');
        const edgeEl = e.target.closest('g.edge, .cv-elabel');
        const start = this.toWorld(e.clientX, e.clientY);
        vp.setPointerCapture(e.pointerId);
        if (e.target.classList.contains('cv-dot')) {
          const n = this.node(nodeEl.dataset.id);
          const side = e.target.dataset.side;
          const tmp = document.createElementNS(SVGNS, 'path');
          tmp.setAttribute('class', 'tmp-edge');
          tmp.setAttribute('marker-end', 'url(#cv-arrow)');
          this.svg.append(tmp);
          act = { type: 'connect', n, side, tmp };
        } else if (e.target.classList.contains('cv-resize')) {
          const n = this.node(nodeEl.dataset.id);
          act = { type: 'resize', n, sx: start.x, sy: start.y, w: n.w, h: n.h };
        } else if (nodeEl) {
          const id = nodeEl.dataset.id;
          if (e.shiftKey) { this.sel.has(id) ? this.sel.delete(id) : this.sel.add(id); }
          else if (!this.sel.has(id)) this.sel = new Set([id]);
          this.markSel();
          act = { type: 'move', sx: start.x, sy: start.y, orig: this.data.nodes.filter((n) => this.sel.has(n.id)).map((n) => ({ n, x: n.x, y: n.y })), moved: false };
        } else if (edgeEl) {
          this.sel = new Set([edgeEl.dataset.id]);
          this.markSel();
        } else {
          if (!e.shiftKey) { this.sel.clear(); this.markSel(); }
          act = { type: 'pan', cx: e.clientX, cy: e.clientY, vx: this.view.x, vy: this.view.y };
          vp.classList.add('panning');
        }
      });
      vp.addEventListener('pointermove', (e) => {
        if (!act) return;
        const p = this.toWorld(e.clientX, e.clientY);
        if (act.type === 'pan') {
          this.view.x = act.vx + e.clientX - act.cx; this.view.y = act.vy + e.clientY - act.cy; this.applyView();
        } else if (act.type === 'move') {
          const dx = p.x - act.sx, dy = p.y - act.sy;
          if (Math.abs(dx) + Math.abs(dy) > 1) act.moved = true;
          for (const o of act.orig) {
            o.n.x = Math.round(o.x + dx); o.n.y = Math.round(o.y + dy);
            const el = this.world.querySelector(`.cv-node[data-id="${o.n.id}"]`);
            if (el) { el.style.left = o.n.x + 'px'; el.style.top = o.n.y + 'px'; }
          }
          this.renderEdges();
        } else if (act.type === 'resize') {
          act.n.w = Math.max(60, Math.round(act.w + p.x - act.sx));
          act.n.h = Math.max(40, Math.round(act.h + p.y - act.sy));
          const el = this.world.querySelector(`.cv-node[data-id="${act.n.id}"]`);
          el.style.width = act.n.w + 'px'; el.style.height = act.n.h + 'px';
          this.renderEdges();
        } else if (act.type === 'connect') {
          const a = this.anchor(act.n, act.side);
          act.tmp.setAttribute('d', this.edgePath(a, act.side, p, null));
        }
      });
      const up = (e) => {
        if (!act) return;
        vp.classList.remove('panning');
        if (act.type === 'connect') {
          act.tmp.remove();
          const under = document.elementFromPoint(e.clientX, e.clientY);
          const target = under && under.closest('.cv-node');
          if (target && target.dataset.id !== act.n.id) {
            const toN = this.node(target.dataset.id);
            const dot = under.closest('.cv-dot');
            this.data.edges.push({ id: S.uid('e_'), from: act.n.id, to: toN.id, fromSide: act.side, toSide: dot ? dot.dataset.side : null, label: '' });
            this.renderEdges(); this.changed();
          } else if (!target) {
            // dropped on empty space: create a connected card there
            const p = this.toWorld(e.clientX, e.clientY);
            const n = this.addNode({ kind: 'text', x: p.x - 110, y: p.y - 40, w: 220, h: 80, text: '' });
            this.data.edges.push({ id: S.uid('e_'), from: act.n.id, to: n.id, fromSide: act.side, label: '' });
            this.render(); this.changed(); this.editNode(n);
          }
        } else if (act.type === 'move' && act.moved) this.changed();
        else if (act.type === 'resize') this.changed();
        else if (act.type === 'pan') this.changed();
        act = null;
      };
      vp.addEventListener('pointerup', up);
      vp.addEventListener('pointercancel', up);

      vp.addEventListener('dblclick', async (e) => {
        if (e.target.closest('textarea')) return;
        const nodeEl = e.target.closest('.cv-node');
        const edgeEl = e.target.closest('g.edge, .cv-elabel');
        if (nodeEl) {
          const n = this.node(nodeEl.dataset.id);
          if (n.kind === 'text') this.editNode(n);
          else if (n.kind === 'page' && S.pages.has(n.pageId)) location.hash = '#/page/' + n.pageId;
          return;
        }
        if (edgeEl) {
          const ed = this.data.edges.find((x) => x.id === edgeEl.dataset.id);
          const label = await S.prompt('Arrow label', ed.label || '', 'e.g. causes, supports, contradicts');
          if (label != null) { ed.label = label; this.renderEdges(); this.changed(); }
          return;
        }
        const p = this.toWorld(e.clientX, e.clientY);
        this.addNode({ kind: 'text', x: Math.round(p.x - 110), y: Math.round(p.y - 50), text: '' }, true);
      });

      vp.addEventListener('contextmenu', (e) => {
        const edgeEl = e.target.closest('g.edge, .cv-elabel');
        if (!edgeEl) return;
        e.preventDefault();
        const ed = this.data.edges.find((x) => x.id === edgeEl.dataset.id);
        S.menu(e.clientX, e.clientY, [
          { label: 'Edit label…', run: async () => { const l = await S.prompt('Arrow label', ed.label || ''); if (l != null) { ed.label = l; this.renderEdges(); this.changed(); } } },
          { label: ed.bidir ? 'One-way arrow' : 'Two-way arrow', run: () => { ed.bidir = !ed.bidir; this.renderEdges(); this.changed(); } },
          { label: 'Reverse direction', run: () => { [ed.from, ed.to] = [ed.to, ed.from]; [ed.fromSide, ed.toSide] = [ed.toSide, ed.fromSide]; this.renderEdges(); this.changed(); } },
          '-',
          { label: 'Delete arrow', danger: true, run: () => { this.data.edges = this.data.edges.filter((x) => x !== ed); this.renderEdges(); this.changed(); } },
        ]);
      });

      vp.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = vp.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        const k0 = this.view.k;
        const k = Math.max(0.1, Math.min(4, k0 * Math.exp(-e.deltaY * 0.0015)));
        this.view.x = mx - (mx - this.view.x) * (k / k0);
        this.view.y = my - (my - this.view.y) * (k / k0);
        this.view.k = k;
        this.applyView();
        clearTimeout(this._wt); this._wt = setTimeout(() => this.changed(), 400);
      }, { passive: false });

      vp.addEventListener('dragover', (e) => e.preventDefault());
      vp.addEventListener('drop', async (e) => {
        e.preventDefault();
        const p = this.toWorld(e.clientX, e.clientY);
        const pid = e.dataTransfer.getData('text/synapse-page');
        if (pid && S.pages.has(pid)) { this.addNode({ kind: 'page', pageId: pid, x: p.x - 130, y: p.y - 70, w: 260, h: 150 }); return; }
        let i = 0;
        for (const f of e.dataTransfer.files) {
          if (!f.type.startsWith('image/')) continue;
          const id = await S.db.putAttachment(f, f.name);
          this.addNode({ kind: 'image', attId: id, x: p.x - 150 + i * 30, y: p.y - 100 + i * 30, w: 300, h: 200 });
          i++;
        }
      });

      this.onKey = (e) => {
        if (!this.root.isConnected) return document.removeEventListener('keydown', this.onKey);
        if (e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return;
        if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel.size) { e.preventDefault(); this.deleteSel(); }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); this.sel = new Set(this.data.nodes.map((n) => n.id)); this.markSel(); }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && this.sel.size) {
          e.preventDefault();
          const clones = this.data.nodes.filter((n) => this.sel.has(n.id)).map((n) => Object.assign({}, n, { id: S.uid('n_'), x: n.x + 30, y: n.y + 30 }));
          this.data.nodes.push(...clones); this.sel = new Set(clones.map((c) => c.id)); this.render(); this.changed();
        }
      };
      document.addEventListener('keydown', this.onKey);

      vp.addEventListener('paste', () => {});
      this.onPaste = async (e) => {
        if (!this.root.isConnected) return document.removeEventListener('paste', this.onPaste);
        if (e.target.closest && e.target.closest('input, textarea')) return;
        const files = [...(e.clipboardData && e.clipboardData.files || [])].filter((f) => f.type.startsWith('image/'));
        const r = vp.getBoundingClientRect();
        const c = this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
        if (files.length) {
          e.preventDefault();
          for (const f of files) { const id = await S.db.putAttachment(f, f.name); this.addNode({ kind: 'image', attId: id, x: c.x - 150, y: c.y - 100, w: 300, h: 200 }); }
          return;
        }
        const text = e.clipboardData.getData('text/plain');
        if (text) { e.preventDefault(); this.addNode({ kind: 'text', x: c.x - 110, y: c.y - 50, text }); }
      };
      document.addEventListener('paste', this.onPaste);
    }

    markSel() {
      this.world.querySelectorAll('.cv-node').forEach((el) => el.classList.toggle('sel', this.sel.has(el.dataset.id)));
      this.svg.querySelectorAll('g.edge').forEach((g) => g.classList.toggle('sel', this.sel.has(g.dataset.id)));
    }

    destroy() {
      document.removeEventListener('keydown', this.onKey);
      document.removeEventListener('paste', this.onPaste);
    }
  };
})(window.S);
