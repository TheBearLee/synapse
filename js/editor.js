/* Synapse — Markdown editor: [[ autocomplete, / slash commands, image paste/drop, list helpers. */
(function (S) {
  'use strict';

  /* Caret pixel coordinates inside a textarea (mirror-div technique) */
  const MIRROR_PROPS = ['boxSizing', 'width', 'height', 'overflowX', 'overflowY', 'borderTopWidth', 'borderRightWidth',
    'borderBottomWidth', 'borderLeftWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle',
    'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'lineHeight', 'fontFamily', 'textAlign', 'textTransform',
    'textIndent', 'letterSpacing', 'wordSpacing', 'tabSize', 'whiteSpace', 'wordBreak', 'overflowWrap'];
  function caretXY(ta, pos) {
    const div = document.createElement('div');
    const cs = getComputedStyle(ta);
    for (const p of MIRROR_PROPS) div.style[p] = cs[p];
    Object.assign(div.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', top: '0', left: '-9999px' });
    div.textContent = ta.value.slice(0, pos);
    const span = document.createElement('span');
    span.textContent = ta.value.slice(pos) || '.';
    div.append(span);
    document.body.append(div);
    const r = ta.getBoundingClientRect();
    const x = r.left + span.offsetLeft - ta.scrollLeft;
    const y = r.top + span.offsetTop - ta.scrollTop + parseFloat(cs.lineHeight || 20);
    div.remove();
    return { x, y };
  }

  /* ---------- Suggest popup (shared by [[ and /) ---------- */
  class Suggest {
    constructor(onPick) {
      this.el = S.h('div.suggest');
      this.items = [];
      this.sel = 0;
      this.onPick = onPick;
      this.el.addEventListener('mousedown', (e) => {
        const b = e.target.closest('[data-i]');
        if (b) { e.preventDefault(); this.pick(+b.dataset.i); }
      });
    }
    show(x, y, items) {
      this.items = items;
      this.sel = 0;
      if (!items.length) return this.hide();
      if (!this.el.isConnected) document.body.append(this.el);
      this.render();
      const r = this.el.getBoundingClientRect();
      this.el.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
      this.el.style.top = (y + r.height > innerHeight - 8 ? Math.max(8, y - r.height - 28) : y) + 'px';
    }
    render() {
      this.el.innerHTML = '';
      this.items.forEach((it, i) => {
        this.el.append(S.h('div.sg-item' + (i === this.sel ? '.on' : ''), { 'data-i': i },
          S.h('span.sg-icon', it.icon || ''), S.h('span.sg-label', it.label),
          it.hint ? S.h('span.sg-hint', it.hint) : null));
      });
      const on = this.el.querySelector('.on');
      on && on.scrollIntoView({ block: 'nearest' });
    }
    get open() { return this.el.isConnected; }
    hide() { this.el.remove(); }
    key(e) {
      if (!this.open) return false;
      if (e.key === 'ArrowDown') { this.sel = (this.sel + 1) % this.items.length; this.render(); }
      else if (e.key === 'ArrowUp') { this.sel = (this.sel - 1 + this.items.length) % this.items.length; this.render(); }
      else if (e.key === 'Enter' || e.key === 'Tab') this.pick(this.sel);
      else if (e.key === 'Escape') this.hide();
      else return false;
      e.preventDefault();
      return true;
    }
    pick(i) { const it = this.items[i]; this.hide(); it && this.onPick(it); }
  }

  /* ---------- Slash commands ---------- */
  S.SLASH = [
    { id: 'h1', label: 'Heading 1', icon: 'H1', insert: '# ' },
    { id: 'h2', label: 'Heading 2', icon: 'H2', insert: '## ' },
    { id: 'h3', label: 'Heading 3', icon: 'H3', insert: '### ' },
    { id: 'todo', label: 'To-do list', icon: '☑', insert: '- [ ] ' },
    { id: 'bullet', label: 'Bulleted list', icon: '•', insert: '- ' },
    { id: 'number', label: 'Numbered list', icon: '1.', insert: '1. ' },
    { id: 'quote', label: 'Quote', icon: '❝', insert: '> ' },
    { id: 'callout', label: 'Callout', icon: '💡', insert: '> [!tip] Title\n> ' },
    { id: 'toggle', label: 'Toggle (collapsible)', icon: '▸', insert: '> [!note]- Click to expand\n> ' },
    { id: 'code', label: 'Code block', icon: '</>', insert: '```\n', after: '\n```' },
    { id: 'table', label: 'Table', icon: '▦', insert: '| Column | Column |\n| --- | --- |\n| ', after: ' |  |' },
    { id: 'divider', label: 'Divider', icon: '—', insert: '---\n' },
    { id: 'highlight', label: 'Highlight', icon: '🖍', insert: '==', after: '==' },
    { id: 'link', label: 'Link to page', icon: '🔗', insert: '[[' , trigger: true },
    { id: 'cite', label: 'Cite a book page', icon: '📖', action: 'cite' },
    { id: 'embed', label: 'Embed page / diagram', icon: '⧉', insert: '![[', trigger: true },
    { id: 'image', label: 'Image', icon: '🖼', action: 'image' },
    { id: 'diagram', label: 'New diagram', icon: '◇', action: 'diagram' },
    { id: 'subpage', label: 'New sub-page', icon: '📄', action: 'subpage' },
    { id: 'query', label: 'Database query', icon: '🗂', insert: '```query\ntype:book\n```\n' },
    { id: 'template', label: 'Insert template', icon: '🧩', action: 'template' },
    { id: 'date', label: 'Today\'s date', icon: '📅', action: 'date' },
  ];

  /**
   * Create an editor bound to a textarea.
   * opts: { page, onChange(text), onAction(id, editor) }
   */
  S.Editor = function (ta, opts) {
    const ed = { ta };
    const sg = new Suggest((it) => it.apply());
    ed.suggest = sg;

    ed.insert = (text, selectAfter = '') => {
      ta.focus();
      const s = ta.selectionStart, e = ta.selectionEnd;
      const sel = ta.value.slice(s, e);
      // execCommand keeps the native undo stack
      if (!document.execCommand('insertText', false, text + sel + selectAfter)) {
        ta.setRangeText(text + sel + selectAfter, s, e, 'end');
      }
      const caret = s + text.length + sel.length;
      ta.setSelectionRange(caret, caret);
      fire();
    };
    ed.replaceRange = (start, end, text, caretOffset) => {
      ta.focus();
      ta.setSelectionRange(start, end);
      if (!document.execCommand('insertText', false, text)) ta.setRangeText(text, start, end, 'end');
      const c = start + (caretOffset == null ? text.length : caretOffset);
      ta.setSelectionRange(c, c);
      fire();
    };
    const fire = () => opts.onChange && opts.onChange(ta.value);

    /* ---- trigger detection ---- */
    function check() {
      const pos = ta.selectionStart;
      if (pos !== ta.selectionEnd) return sg.hide();
      const before = ta.value.slice(0, pos);
      const lineStart = before.lastIndexOf('\n') + 1;
      const line = before.slice(lineStart);

      // [[ autocomplete
      const lm = line.match(/(!?)\[\[([^\[\]|]*)$/);
      if (lm) {
        const q = lm[2];
        const start = pos - q.length;
        const xy = caretXY(ta, start);
        const hashI = q.indexOf('#');
        const atI = q.indexOf('@');
        if (hashI >= 0) { // heading completion
          const title = q.slice(0, hashI);
          const page = S.findByTitle(title);
          const hq = q.slice(hashI + 1);
          if (!page) return sg.hide();
          const items = S.headings(page.content).filter((h) => S.fuzzy(hq, h.text) >= 0).slice(0, 12).map((h) => ({
            icon: 'H' + h.level, label: h.text,
            apply: () => ed.replaceRange(start + hashI + 1, pos + closeLen(), h.text + ']]'),
          }));
          return sg.show(xy.x, xy.y, items);
        }
        if (atI >= 0) return sg.hide(); // free-form locator
        const results = S.livePages().filter((p) => p.type !== 'template' && p.id !== (opts.page && opts.page.id))
          .map((p) => ({ p, s: S.fuzzy(q, p.title) })).filter((r) => r.s >= 0)
          .sort((a, b) => b.s - a.s || b.p.updated - a.p.updated).slice(0, 10)
          .map(({ p }) => ({
            icon: S.pageIcon(p), label: p.title, hint: S.TYPES[p.type] ? S.TYPES[p.type].label : '',
            apply: () => ed.replaceRange(start, pos + closeLen(), p.title + ']]'),
          }));
        if (q.trim() && !S.findByTitle(q)) {
          results.push({ icon: '＋', label: `Create “${q.trim()}”`, hint: 'new page',
            apply: () => ed.replaceRange(start, pos + closeLen(), q.trim() + ']]') });
        }
        return sg.show(xy.x, xy.y, results);
      }

      // slash menu: "/" at line start or after whitespace
      const sm = line.match(/(^|\s)\/([\w-]*)$/);
      if (sm) {
        const q = sm[2];
        const start = pos - q.length - 1;
        const xy = caretXY(ta, start);
        const items = S.SLASH.map((c) => ({ c, s: S.fuzzy(q, c.label + ' ' + c.id) })).filter((r) => r.s >= 0)
          .sort((a, b) => b.s - a.s).slice(0, 12).map(({ c }) => ({
            icon: c.icon, label: c.label,
            apply: () => {
              ed.replaceRange(start, pos, '');
              if (c.action) return opts.onAction && opts.onAction(c.action, ed);
              ed.insert(c.insert, c.after || '');
              if (c.trigger) setTimeout(check, 0);
            },
          }));
        return sg.show(xy.x, xy.y, items);
      }
      sg.hide();
    }
    const closeLen = () => (ta.value.slice(ta.selectionStart, ta.selectionStart + 2) === ']]' ? 2 : 0);

    /* ---- keys ---- */
    ta.addEventListener('keydown', (e) => {
      if (sg.key(e)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); wrap('**'); return; }
      if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); wrap('*'); return; }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'h') { e.preventDefault(); wrap('=='); return; }
      if (mod && e.key === 'Enter') { e.preventDefault(); toggleTask(); return; }
      if (e.key === 'Tab') { e.preventDefault(); indent(e.shiftKey); return; }
      if (e.key === 'Enter' && !e.shiftKey) { if (continueList()) e.preventDefault(); return; }
      if (e.key === '[' && !mod) { // auto-close [[
        const p = ta.selectionStart;
        if (ta.value[p - 1] === '[' && ta.selectionStart === ta.selectionEnd) {
          e.preventDefault();
          ed.replaceRange(p, p, '[]]', 1);
          setTimeout(check, 0);
        }
      }
    });
    ta.addEventListener('input', () => { fire(); check(); });
    ta.addEventListener('click', () => sg.hide());
    ta.addEventListener('blur', () => setTimeout(() => sg.hide(), 120));

    function wrap(m) {
      const s = ta.selectionStart, e = ta.selectionEnd;
      const sel = ta.value.slice(s, e);
      ed.replaceRange(s, e, m + sel + m, sel ? m.length * 2 + sel.length : m.length);
    }
    function lineBounds() {
      const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      let le = v.indexOf('\n', e); if (le < 0) le = v.length;
      return { ls, le };
    }
    function indent(out) {
      const { ls, le } = lineBounds();
      const s0 = ta.selectionStart, e0 = ta.selectionEnd;
      const block = ta.value.slice(ls, le);
      const lines = block.split('\n');
      const nb = lines.map((l) => out ? l.replace(/^( {1,4}|\t)/, '') : '    ' + l).join('\n');
      ed.replaceRange(ls, le, nb);
      const d = nb.length - block.length;
      if (s0 === e0) { const c = Math.max(ls, s0 + (lines.length === 1 ? d : 0)); ta.setSelectionRange(c, c); }
      else ta.setSelectionRange(ls, ls + nb.length);
    }
    function toggleTask() {
      const { ls } = lineBounds();
      let le = ta.value.indexOf('\n', ls); if (le < 0) le = ta.value.length;
      const line = ta.value.slice(ls, le);
      let nl;
      if (/^\s*[-*+] \[[xX]\] /.test(line)) nl = line.replace(/\[[xX]\]/, '[ ]');
      else if (/^\s*[-*+] \[ \] /.test(line)) nl = line.replace('[ ]', '[x]');
      else nl = line.replace(/^(\s*)(?:[-*+] )?/, '$1- [ ] ');
      const caret = ta.selectionStart + (nl.length - line.length);
      ed.replaceRange(ls, le, nl);
      ta.setSelectionRange(caret, caret);
    }
    function continueList() {
      const pos = ta.selectionStart;
      if (pos !== ta.selectionEnd) return false;
      const v = ta.value;
      const ls = v.lastIndexOf('\n', pos - 1) + 1;
      const line = v.slice(ls, pos);
      const m = line.match(/^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)([.)]) |> )/);
      if (!m) return false;
      if (line.trim() === m[2].trim()) { // empty item → end list
        ed.replaceRange(ls, pos, '');
        return true;
      }
      let marker = m[2];
      if (m[3]) marker = (parseInt(m[3], 10) + 1) + m[4] + ' ';
      if (/\[[xX]\]/.test(marker)) marker = marker.replace(/\[[xX]\]/, '[ ]');
      ed.insert('\n' + m[1] + marker);
      return true;
    }

    /* ---- images: paste & drop ---- */
    async function addImages(files) {
      for (const f of files) {
        if (!f.type.startsWith('image/')) continue;
        const id = await S.db.putAttachment(f, f.name || 'pasted-image.png');
        ed.insert(`![${(f.name || 'image').replace(/\.[^.]+$/, '').replace(/[\[\]]/g, '')}](attachment:${id})\n`);
      }
    }
    ed.addImages = addImages;
    ta.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData && e.clipboardData.files || [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); addImages(files); }
    });
    ta.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); ta.classList.add('drop'); } });
    ta.addEventListener('dragleave', () => ta.classList.remove('drop'));
    ta.addEventListener('drop', (e) => {
      ta.classList.remove('drop');
      const files = [...e.dataTransfer.files];
      if (files.length) { e.preventDefault(); addImages(files); return; }
      const pid = e.dataTransfer.getData('text/synapse-page');
      if (pid && S.pages.has(pid)) { e.preventDefault(); ed.insert(`[[${S.pages.get(pid).title}]]`); }
    });

    ed.destroy = () => sg.hide();
    return ed;
  };

  S.pageIcon = (p) => p.icon || (S.TYPES[p.type] ? S.TYPES[p.type].icon : '📄');
})(window.S);
