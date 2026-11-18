/* Synapse — shared helpers. Everything hangs off window.S */
window.S = window.S || {};
(function (S) {
  'use strict';

  S.uid = (prefix = '') =>
    prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  S.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

  S.slug = (s) =>
    String(s).toLowerCase().trim()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-');

  S.debounce = (fn, ms) => {
    let t, pending = null;
    const d = (...a) => { clearTimeout(t); pending = a; t = setTimeout(() => { const args = pending; pending = null; fn(...args); }, ms); };
    // flush only runs if a call is actually waiting (never re-saves stale data)
    d.flush = () => { clearTimeout(t); if (pending) { const args = pending; pending = null; fn(...args); } };
    d.cancel = () => { clearTimeout(t); pending = null; };
    return d;
  };

  /** Tiny element builder: S.h('div.cls#id', {attrs}, children...) */
  S.h = (sel, attrs, ...kids) => {
    const m = sel.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
    const el = document.createElement((m && m[1]) || 'div');
    if (m && m[2]) {
      m[2].replace(/([.#])([\w-]+)/g, (_, t, v) => {
        if (t === '.') el.classList.add(v); else el.id = v;
      });
    }
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
      kids.unshift(attrs); attrs = null;
    }
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k in el && typeof v !== 'string') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const k of kids.flat(Infinity)) {
      if (k == null || k === false) continue;
      el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return el;
  };

  S.fmtDate = (ts, withTime) => {
    const d = new Date(ts);
    const opts = { year: 'numeric', month: 'short', day: 'numeric' };
    if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleString(undefined, opts);
  };
  S.isoDay = (d = new Date()) => {
    const z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  };
  S.ago = (ts) => {
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago';
    return S.fmtDate(ts);
  };

  /** Fuzzy score: higher is better, -1 = no match */
  S.fuzzy = (query, text) => {
    query = query.toLowerCase(); text = text.toLowerCase();
    if (!query) return 0;
    const idx = text.indexOf(query);
    if (idx >= 0) return 1000 - idx * 2 - (text.length - query.length) * 0.5 + (idx === 0 ? 200 : 0);
    let ti = 0, score = 0, streak = 0;
    for (const c of query) {
      const f = text.indexOf(c, ti);
      if (f < 0) return -1;
      streak = f === ti ? streak + 1 : 0;
      score += 5 + streak * 3 - (f - ti) * 0.2;
      ti = f + 1;
    }
    return score;
  };

  /* ---------- toast ---------- */
  let toastT;
  S.toast = (msg, ms = 2400) => {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('show'), ms);
  };

  /* ---------- modal ---------- */
  S.modal = (title, body, { wide, onClose } = {}) => {
    const ov = document.getElementById('overlay');
    ov.innerHTML = '';
    const close = () => { ov.hidden = true; ov.innerHTML = ''; document.removeEventListener('keydown', onKey, true); onClose && onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const box = S.h('div.modal' + (wide ? '.wide' : ''),
      S.h('div.modal-head', S.h('h3', title), S.h('button.icon-btn', { onclick: close, title: 'Close' }, '✕')),
      S.h('div.modal-body', body));
    ov.append(box);
    ov.hidden = false;
    ov.onclick = (e) => { if (e.target === ov) close(); };
    document.addEventListener('keydown', onKey, true);
    return { close, box };
  };

  S.prompt = (title, value = '', placeholder = '') => new Promise((res) => {
    const input = S.h('input.input', { value, placeholder });
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); res(v); };
    const m = S.modal(title, [
      input,
      S.h('div.row.end', S.h('button.btn', { onclick: () => finish(null) }, 'Cancel'),
        S.h('button.btn.primary', { onclick: () => finish(input.value.trim()) }, 'OK'))
    ], { onClose: () => { if (!done) { done = true; res(null); } } });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value.trim()); });
    setTimeout(() => { input.focus(); input.select(); }, 20);
  });

  S.confirm = (title, msg, okLabel = 'OK') => new Promise((res) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); res(v); };
    const m = S.modal(title, [S.h('p', msg),
      S.h('div.row.end', S.h('button.btn', { onclick: () => finish(false) }, 'Cancel'),
        S.h('button.btn.danger', { onclick: () => finish(true) }, okLabel))],
      { onClose: () => { if (!done) { done = true; res(false); } } });
  });

  /* ---------- popup menu ---------- */
  S.menu = (x, y, items) => {
    S.closeMenu();
    const m = S.h('div.popmenu#popmenu');
    for (const it of items) {
      if (it === '-') { m.append(S.h('div.sep')); continue; }
      m.append(S.h('button' + (it.danger ? '.danger' : ''), {
        onclick: (e) => { e.stopPropagation(); S.closeMenu(); it.run(); }
      }, it.label));
    }
    document.body.append(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
    m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
    setTimeout(() => document.addEventListener('mousedown', S._menuAway, true), 0);
  };
  S._menuAway = (e) => { if (!e.target.closest('#popmenu')) S.closeMenu(); };
  S.closeMenu = () => {
    const m = document.getElementById('popmenu');
    if (m) m.remove();
    document.removeEventListener('mousedown', S._menuAway, true);
  };

  /** Pick a file via hidden input */
  S.pickFile = (accept, multiple = false) => new Promise((res) => {
    const inp = document.getElementById('file-input');
    inp.value = '';
    inp.accept = accept || '';
    inp.multiple = multiple;
    inp.onchange = () => res(multiple ? [...inp.files] : inp.files[0] || null);
    inp.click();
  });

  S.download = (blob, name) => {
    const a = S.h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  S.EMOJI = ['📄', '📝', '💡', '🧠', '📚', '📖', '🔖', '🧩', '🔬', '🧪', '🎯', '🚀', '🌱', '🌳', '🔥', '⭐',
    '💬', '🗺️', '🧭', '🏛️', '🎨', '🎵', '🎬', '💻', '⚙️', '📊', '📈', '🧮', '🗂️', '📅', '✅', '❓',
    '❗', '🔗', '🕸️', '◇', '👤', '👥', '🏠', '✈️', '🍳', '💪', '🧘', '💰', '🛠️', '🔒', '🌍', '🪐'];

  S.TYPES = {
    note: { label: 'Note', icon: '📝', color: '#7c5cff' },
    book: { label: 'Book', icon: '📚', color: '#f59e0b' },
    source: { label: 'Article / Source', icon: '🔖', color: '#10b981' },
    person: { label: 'Person', icon: '👤', color: '#ec4899' },
    project: { label: 'Project', icon: '🎯', color: '#3b82f6' },
    concept: { label: 'Concept', icon: '💡', color: '#eab308' },
    daily: { label: 'Daily note', icon: '📅', color: '#64748b' },
    canvas: { label: 'Diagram', icon: '◇', color: '#06b6d4' },
    template: { label: 'Template', icon: '🧩', color: '#a855f7' },
  };
  S.STATUSES = ['Inbox', 'To read', 'In progress', 'Done', 'Archived'];
})(window.S);
