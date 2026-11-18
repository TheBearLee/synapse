/* Synapse — force-directed knowledge graph on <canvas>. */
(function (S) {
  'use strict';
  const posCache = new Map(); // id -> {x,y}

  S.Graph = class {
    /**
     * opts: { focusId, depth, onOpen(node), settings:{tags,ghosts,orphans,hierarchy,templates,daily}, mini }
     */
    constructor(host, opts = {}) {
      this.host = host;
      this.opts = opts;
      this.set = Object.assign({ tags: false, ghosts: true, orphans: true, hierarchy: false, daily: true, repel: 1, linkDist: 1, search: '', types: null }, opts.settings || {});
      this.canvas = S.h('canvas.graph-canvas');
      host.append(this.canvas);
      this.ctx = this.canvas.getContext('2d');
      this.view = { x: 0, y: 0, k: opts.mini ? 0.8 : 1 };
      this.hover = null;
      this.drag = null;
      this.alpha = 1;
      this.build();
      this.bind();
      this.resize();
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(host);
      this.loop = this.loop.bind(this);
      this.raf = requestAnimationFrame(this.loop);
      if (!opts.mini) setTimeout(() => this.fit(), 900);
    }

    destroy() { cancelAnimationFrame(this.raf); this.ro.disconnect(); this.dead = true; this.canvas.remove(); }

    build() {
      const st = this.set;
      const nodes = new Map();
      const edges = [];
      const pages = S.livePages().filter((p) => (p.type !== 'template' || st.templates) && (p.type !== 'daily' || st.daily) && (!st.types || st.types.has(p.type)));
      const add = (id, label, kind, page) => {
        if (nodes.has(id)) return nodes.get(id);
        const c = posCache.get(id) || { x: (Math.random() - 0.5) * 400, y: (Math.random() - 0.5) * 400 };
        const n = { id, label, kind, page, x: c.x, y: c.y, vx: 0, vy: 0, deg: 0 };
        nodes.set(id, n);
        return n;
      };
      for (const p of pages) add(p.id, p.title, p.type, p);
      const seen = new Set();
      const link = (a, b, kind) => {
        if (!a || !b || a === b) return;
        const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
        if (seen.has(key)) return;
        seen.add(key);
        edges.push({ s: a, t: b, kind });
        a.deg++; b.deg++;
      };
      for (const p of pages) {
        const src = nodes.get(p.id);
        for (const l of S.linkIndex.out.get(p.id) || []) {
          if (l.to) link(src, nodes.get(l.to), l.locator ? 'cite' : 'link');
          else if (st.ghosts) link(src, add('ghost:' + l.title.toLowerCase(), l.title, 'ghost'), 'link');
        }
        if (st.tags) for (const t of S.pageTags(p.id)) link(src, add('tag:' + t, '#' + t, 'tag'), 'tag');
        if (st.hierarchy && p.parentId) link(src, nodes.get(p.parentId), 'child');
      }
      let list = [...nodes.values()];
      // local graph: BFS from focus
      if (this.opts.focusId) {
        const depth = this.opts.depth || 1;
        const adj = new Map();
        for (const e of edges) {
          (adj.get(e.s.id) || adj.set(e.s.id, []).get(e.s.id)).push(e.t.id);
          (adj.get(e.t.id) || adj.set(e.t.id, []).get(e.t.id)).push(e.s.id);
        }
        const keep = new Set([this.opts.focusId]);
        let frontier = [this.opts.focusId];
        for (let d = 0; d < depth; d++) {
          const next = [];
          for (const id of frontier) for (const nb of adj.get(id) || []) if (!keep.has(nb)) { keep.add(nb); next.push(nb); }
          frontier = next;
        }
        list = list.filter((n) => keep.has(n.id));
        const f = nodes.get(this.opts.focusId);
        if (f && !posCache.has(f.id)) { f.x = 0; f.y = 0; }
      } else if (!st.orphans) {
        list = list.filter((n) => n.deg > 0);
      }
      const keepSet = new Set(list.map((n) => n.id));
      this.nodes = list;
      this.edges = edges.filter((e) => keepSet.has(e.s.id) && keepSet.has(e.t.id));
      this.nbrs = new Map(list.map((n) => [n.id, new Set()]));
      for (const e of this.edges) { this.nbrs.get(e.s.id).add(e.t.id); this.nbrs.get(e.t.id).add(e.s.id); }
      this.alpha = 1;
      this.applySearch();
    }

    applySearch() {
      const q = (this.set.search || '').trim().toLowerCase();
      this.match = q ? new Set(this.nodes.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id)) : null;
    }

    update(settings) { Object.assign(this.set, settings); this.build(); }

    resize() {
      const r = this.host.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.w = r.width; this.hgt = r.height;
      this.canvas.width = r.width * dpr; this.canvas.height = r.height * dpr;
      this.canvas.style.width = r.width + 'px'; this.canvas.style.height = r.height + 'px';
      this.dpr = dpr;
    }

    fit() {
      if (!this.nodes.length) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of this.nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
      const pad = 60;
      const k = Math.min(2, Math.max(0.1, Math.min((this.w - pad * 2) / (x1 - x0 || 1), (this.hgt - pad * 2) / (y1 - y0 || 1))));
      this.view.k = k;
      this.view.x = -(x0 + x1) / 2 * k;
      this.view.y = -(y0 + y1) / 2 * k;
    }

    tick() {
      const ns = this.nodes, a = this.alpha;
      const rep = 3600 * this.set.repel, L = 95 * this.set.linkDist;
      const n = ns.length;
      // repulsion (O(n²), sampled for very large graphs)
      const stride = n > 900 ? 3 : 1;
      for (let i = 0; i < n; i++) {
        const p = ns[i];
        for (let j = i + 1; j < n; j += stride) {
          const q = ns[j];
          let dx = p.x - q.x, dy = p.y - q.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.5; }
          if (d2 > 250000) continue;
          const f = (rep * a * stride) / d2;
          const d = Math.sqrt(d2);
          dx /= d; dy /= d;
          p.vx += dx * f; p.vy += dy * f; q.vx -= dx * f; q.vy -= dy * f;
        }
      }
      for (const e of this.edges) {
        const dx = e.t.x - e.s.x, dy = e.t.y - e.s.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = ((d - L) / d) * 0.06 * a;
        e.s.vx += dx * f; e.s.vy += dy * f; e.t.vx -= dx * f; e.t.vy -= dy * f;
      }
      for (const p of ns) {
        p.vx -= p.x * 0.004 * a; p.vy -= p.y * 0.004 * a; // gravity to center
        if (this.drag && this.drag.node === p) { p.vx = p.vy = 0; continue; }
        p.vx *= 0.6; p.vy *= 0.6;
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > 40) { p.vx *= 40 / sp; p.vy *= 40 / sp; }
        p.x += p.vx; p.y += p.vy;
        posCache.set(p.id, { x: p.x, y: p.y });
      }
      this.alpha = Math.max(this.drag ? 0.3 : 0, a * 0.985);
    }

    radius(n) { return (n.kind === 'tag' ? 3 : 4) + Math.min(14, Math.sqrt(n.deg) * 2.2) + (n.id === this.opts.focusId ? 3 : 0); }

    color(n) {
      if (n.kind === 'ghost') return this.css.muted;
      if (n.kind === 'tag') return '#22c55e';
      return (S.TYPES[n.kind] && S.TYPES[n.kind].color) || '#7c5cff';
    }

    draw() {
      const c = this.ctx, v = this.view, dpr = this.dpr;
      const cs = getComputedStyle(document.documentElement);
      this.css = { text: cs.getPropertyValue('--text').trim(), muted: cs.getPropertyValue('--muted').trim(), line: cs.getPropertyValue('--graph-line').trim(), bg: cs.getPropertyValue('--bg').trim(), accent: cs.getPropertyValue('--accent').trim() };
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, this.w, this.hgt);
      c.translate(this.w / 2 + v.x, this.hgt / 2 + v.y);
      c.scale(v.k, v.k);
      const hv = this.hover;
      const hn = hv ? this.nbrs.get(hv.id) : null;
      const active = (n) => !hv || n === hv || (hn && hn.has(n.id));
      const lit = (n) => !this.match || this.match.has(n.id);

      // edges
      for (const e of this.edges) {
        const on = hv && (e.s === hv || e.t === hv);
        c.globalAlpha = hv ? (on ? 0.9 : 0.08) : (this.match ? (lit(e.s) && lit(e.t) ? 0.6 : 0.06) : 0.5);
        c.strokeStyle = on ? this.css.accent : e.kind === 'cite' ? '#f59e0b' : this.css.line;
        c.lineWidth = (on ? 1.8 : 1) / Math.sqrt(v.k);
        c.setLineDash(e.kind === 'tag' || e.kind === 'child' ? [3, 3] : []);
        c.beginPath(); c.moveTo(e.s.x, e.s.y); c.lineTo(e.t.x, e.t.y); c.stroke();
      }
      c.setLineDash([]);
      // nodes
      for (const n of this.nodes) {
        const r = this.radius(n);
        c.globalAlpha = (active(n) ? 1 : 0.15) * (lit(n) ? 1 : 0.15);
        c.fillStyle = this.color(n);
        c.beginPath(); c.arc(n.x, n.y, r, 0, Math.PI * 2);
        if (n.kind === 'ghost') { c.strokeStyle = this.css.muted; c.lineWidth = 1.2; c.setLineDash([2, 2]); c.stroke(); c.setLineDash([]); }
        else c.fill();
        if (n === hv || n.id === this.opts.focusId) { c.strokeStyle = this.css.accent; c.lineWidth = 2.5 / v.k; c.stroke(); }
      }
      // labels
      const fs = 12 / Math.max(0.6, Math.min(v.k, 1.6));
      c.font = `${fs}px Inter, system-ui, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'top';
      for (const n of this.nodes) {
        const show = n === hv || (hn && hn.has(n.id)) || v.k > 0.85 || n.deg > 6 || (this.match && this.match.has(n.id)) || (this.opts.mini && v.k > 0.5);
        if (!show) continue;
        c.globalAlpha = (active(n) ? 1 : 0.2) * (lit(n) ? 1 : 0.2);
        const label = n.label.length > 32 ? n.label.slice(0, 30) + '…' : n.label;
        c.lineWidth = 3 / v.k; c.strokeStyle = this.css.bg;
        c.strokeText(label, n.x, n.y + this.radius(n) + 3);
        c.fillStyle = n.kind === 'ghost' ? this.css.muted : this.css.text;
        c.fillText(label, n.x, n.y + this.radius(n) + 3);
      }
      c.globalAlpha = 1;
    }

    loop() {
      if (this.dead) return;
      if (this.alpha > 0.003) this.tick();
      this.draw();
      this.raf = requestAnimationFrame(this.loop);
    }

    toWorld(cx, cy) {
      const r = this.canvas.getBoundingClientRect();
      return { x: (cx - r.left - this.w / 2 - this.view.x) / this.view.k, y: (cy - r.top - this.hgt / 2 - this.view.y) / this.view.k };
    }
    pick(cx, cy) {
      const p = this.toWorld(cx, cy);
      let best = null, bd = Infinity;
      for (const n of this.nodes) {
        const d = Math.hypot(n.x - p.x, n.y - p.y);
        if (d < this.radius(n) + 5 / this.view.k && d < bd) { best = n; bd = d; }
      }
      return best;
    }

    bind() {
      const cv = this.canvas;
      let down = null;
      cv.addEventListener('pointerdown', (e) => {
        cv.setPointerCapture(e.pointerId);
        const n = this.pick(e.clientX, e.clientY);
        down = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, node: n, moved: false };
        if (n) { this.drag = { node: n }; this.alpha = Math.max(this.alpha, 0.3); }
      });
      cv.addEventListener('pointermove', (e) => {
        if (!down) {
          const n = this.pick(e.clientX, e.clientY);
          if (n !== this.hover) { this.hover = n; cv.style.cursor = n ? 'pointer' : 'grab'; this.onHover && this.onHover(n, e); }
          return;
        }
        if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3) down.moved = true;
        if (down.node) { const p = this.toWorld(e.clientX, e.clientY); down.node.x = p.x; down.node.y = p.y; }
        else { this.view.x = down.vx + e.clientX - down.x; this.view.y = down.vy + e.clientY - down.y; cv.style.cursor = 'grabbing'; }
      });
      const up = (e) => {
        if (!down) return;
        if (!down.moved && down.node && this.opts.onOpen) this.opts.onOpen(down.node, e);
        down = null; this.drag = null; cv.style.cursor = 'grab';
      };
      cv.addEventListener('pointerup', up);
      cv.addEventListener('pointercancel', up);
      cv.addEventListener('pointerleave', () => { if (!down && this.hover) { this.hover = null; this.onHover && this.onHover(null); } });
      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = cv.getBoundingClientRect();
        const mx = e.clientX - r.left - this.w / 2, my = e.clientY - r.top - this.hgt / 2;
        const k0 = this.view.k;
        const k = Math.max(0.05, Math.min(5, k0 * Math.exp(-e.deltaY * 0.0015)));
        this.view.x = mx - (mx - this.view.x) * (k / k0);
        this.view.y = my - (my - this.view.y) * (k / k0);
        this.view.k = k;
      }, { passive: false });
    }
  };
})(window.S);
