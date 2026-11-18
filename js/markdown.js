/* Synapse — a small, dependency-free Markdown renderer with wiki-link support. */
(function (S) {
  'use strict';
  const esc = S.esc;

  function safeUrl(u) {
    u = String(u).trim();
    if (/^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(u) || !/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
    return '#';
  }

  S.locatorLabel = (loc) => /^\d+([-–]\d+)?$/.test(loc) ? 'p. ' + loc : loc;

  S.wikiHTML = (l) => {
    const page = S.findByTitle(l.target);
    let label = l.alias;
    if (!label) {
      label = l.target;
      if (l.heading) label += ' › ' + l.heading;
      if (l.locator) label += ', ' + S.locatorLabel(l.locator);
    }
    const attrs = [
      `class="wikilink${page ? '' : ' ghost'}${l.locator ? ' cite' : ''}"`,
      `href="#"`,
      `data-target="${esc(l.target)}"`,
      l.heading ? `data-heading="${esc(l.heading)}"` : '',
      l.locator ? `data-locator="${esc(l.locator)}"` : '',
      `title="${esc(page ? (page.title + (l.heading ? ' › ' + l.heading : '') + (l.locator ? ' @ ' + l.locator : '')) : 'Click to create “' + l.target + '”')}"`,
    ].join(' ');
    const icon = page && page.type === 'book' && l.locator ? '📖 ' : '';
    return `<a ${attrs}>${icon}${esc(label)}</a>`;
  };

  /* ---------- inline ---------- */
  function inline(src) {
    const stash = [];
    const put = (html) => '\u0000' + (stash.push(html) - 1) + '\u0000';
    let s = src;
    s = s.replace(/`([^`\n]+)`/g, (_, c) => put(`<code>${esc(c)}</code>`));
    // inline wiki embeds of images: ![[image.png]] are not used; images use ![alt](attachment:id)
    s = s.replace(S.LINK_RE, (m, bang, target, heading, locator, alias) =>
      put(S.wikiHTML({ target: target.trim(), heading: heading && heading.trim(), locator: locator && locator.trim(), alias: alias && alias.trim() })));
    s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, alt, url, w) => {
      const width = w && /^\d+$/.test(w) ? ` style="width:${w}px"` : '';
      if (url.startsWith('attachment:')) return put(`<img class="md-img" data-att="${esc(url.slice(11))}" alt="${esc(alt)}"${width}>`);
      return put(`<img class="md-img" src="${esc(safeUrl(url))}" alt="${esc(alt)}"${width}>`);
    });
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, text, url) =>
      put(`<a class="extlink" href="${esc(safeUrl(url))}" target="_blank" rel="noopener">${inlineBasic(text)}</a>`));
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, url) =>
      pre + put(`<a class="extlink" href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`));
    s = s.replace(S.TAG_RE, (_, pre, tag) => pre + put(`<a class="tag" href="#/tag/${encodeURIComponent(tag.toLowerCase())}">#${esc(tag)}</a>`));
    s = inlineBasic(s);
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
  }
  function inlineBasic(s) {
    s = esc(s);
    return s
      .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
  }
  S.inlineMD = inline;

  /* ---------- blocks ---------- */
  const RE = {
    fence: /^\s*(```|~~~)\s*([\w+-]*)\s*(.*)$/,
    heading: /^(#{1,6})\s+(.*?)\s*#*\s*$/,
    hr: /^\s*([-*_])(\s*\1){2,}\s*$/,
    list: /^(\s*)([-*+]|\d+[.)])\s+(.*)$/,
    quote: /^\s*>\s?(.*)$/,
    tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
    embed: /^\s*!\[\[([^\]]+)\]\]\s*$/,
  };
  const isBlockStart = (line, next) =>
    RE.fence.test(line) || RE.heading.test(line) || RE.hr.test(line) || RE.list.test(line) ||
    RE.quote.test(line) || RE.embed.test(line) || (line.includes('|') && next != null && RE.tableSep.test(next));

  function renderBlocks(lines, offset, ctx) {
    let html = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m;
      // fenced code / special blocks
      if ((m = line.match(RE.fence))) {
        const fence = m[1], lang = m[2].toLowerCase();
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
        i++;
        const code = body.join('\n');
        if (lang === 'query') html += `<div class="query-block" data-q="${esc(code.trim())}"></div>`;
        else html += `<pre class="code"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(code)}</code></pre>`;
        continue;
      }
      if ((m = line.match(RE.heading))) {
        const lvl = m[1].length;
        const text = m[2];
        html += `<h${lvl} id="h-${esc(S.slug(text))}" data-line="${offset + i}">${inline(text)}</h${lvl}>`;
        i++; continue;
      }
      if (RE.hr.test(line)) { html += '<hr>'; i++; continue; }
      if ((m = line.match(RE.embed))) {
        const inner = m[1];
        const parts = inner.match(/^([^#|@]+)(?:#([^|@]+))?(?:@([^|]+))?(?:\|(.+))?$/) || [null, inner];
        html += `<div class="embed" data-target="${esc(parts[1].trim())}"${parts[2] ? ` data-heading="${esc(parts[2].trim())}"` : ''}${parts[4] ? ` data-size="${esc(parts[4].trim())}"` : ''}></div>`;
        i++; continue;
      }
      if (RE.quote.test(line)) {
        const body = [];
        const start = i;
        while (i < lines.length && RE.quote.test(lines[i])) body.push(lines[i++].match(RE.quote)[1]);
        const cm = body[0].match(/^\[!(\w+)\]([+-]?)\s*(.*)$/);
        if (cm) {
          const type = cm[1].toLowerCase();
          const title = cm[3] || type[0].toUpperCase() + type.slice(1);
          const fold = cm[2];
          const inner = renderBlocks(body.slice(1), offset + start + 1, ctx);
          if (fold) html += `<details class="callout c-${esc(type)}"${fold === '+' ? ' open' : ''}><summary class="callout-title">${calloutIcon(type)} ${inline(title)}</summary><div class="callout-body">${inner}</div></details>`;
          else html += `<div class="callout c-${esc(type)}"><div class="callout-title">${calloutIcon(type)} ${inline(title)}</div><div class="callout-body">${inner}</div></div>`;
        } else {
          html += `<blockquote>${renderBlocks(body, offset + start, ctx)}</blockquote>`;
        }
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && RE.tableSep.test(lines[i + 1])) {
        const split = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
        const head = split(line);
        const aligns = split(lines[i + 1]).map((c) => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : '');
        i += 2;
        let t = '<div class="table-wrap"><table><thead><tr>' + head.map((c, k) => `<th${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          const row = split(lines[i++]);
          t += '<tr>' + head.map((_, k) => `<td${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(row[k] || '')}</td>`).join('') + '</tr>';
        }
        html += t + '</tbody></table></div>';
        continue;
      }
      if (RE.list.test(line)) {
        const items = [];
        while (i < lines.length) {
          const l = lines[i];
          const lm = l.match(RE.list);
          if (lm) { items.push({ indent: lm[1].replace(/\t/g, '    ').length, ordered: /\d/.test(lm[2]), start: parseInt(lm[2], 10), text: lm[3], line: offset + i }); i++; continue; }
          if (l.trim() && /^\s{2,}/.test(l) && items.length) { items[items.length - 1].text += ' ' + l.trim(); i++; continue; }
          break;
        }
        html += renderList(items);
        continue;
      }
      // paragraph
      const para = [];
      const pStart = offset + i;
      while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i], lines[i + 1]))) {
        para.push(lines[i++]);
      }
      html += `<p data-line="${pStart}">` + para.map((l) => inline(l.replace(/\s+$/, '')) + (/ {2}$|\\$/.test(l) ? '<br>' : '')).join('\n').replace(/\\<br>/g, '<br>') + '</p>';
    }
    return html;
  }

  function renderList(items) {
    let html = '';
    const stack = [];
    for (const it of items) {
      while (stack.length && it.indent < stack[stack.length - 1].indent) html += '</li></' + stack.pop().tag + '>';
      const top = stack[stack.length - 1];
      if (!top || it.indent > top.indent) {
        const tag = it.ordered ? 'ol' : 'ul';
        stack.push({ indent: it.indent, tag });
        html += `<${tag}${it.ordered && it.start > 1 ? ` start="${it.start}"` : ''}>`;
      } else {
        html += '</li>';
      }
      const task = it.text.match(/^\[([ xX/-])\]\s+(.*)$/);
      if (task) {
        const done = task[1].toLowerCase() === 'x';
        html += `<li class="task${done ? ' done' : ''}"><input type="checkbox" data-line="${it.line}"${done ? ' checked' : ''}> <span>${inline(task[2])}</span>`;
      } else html += `<li>${inline(it.text)}`;
    }
    while (stack.length) html += '</li></' + stack.pop().tag + '>';
    return html;
  }

  function calloutIcon(t) {
    return ({ note: '📝', info: 'ℹ️', tip: '💡', idea: '💡', important: '❗', warning: '⚠️', caution: '⚠️', danger: '🔥', question: '❓', quote: '❝', example: '🧪', summary: '📋', todo: '☑️', success: '✅' })[t] || '📌';
  }

  /** Strip YAML frontmatter if present */
  S.splitFrontmatter = (text) => {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return { meta: {}, body: text };
    const meta = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([\w-]+):\s*(.*)$/);
      if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').replace(/^\[(.*)\]$/, '$1');
    }
    return { meta, body: text.slice(m[0].length) };
  };

  S.md = (text, ctx = {}) => renderBlocks(String(text || '').replace(/\r\n?/g, '\n').split('\n'), 0, ctx);

  /** Plain-text excerpt for cards / search */
  S.excerpt = (text, n = 160) => {
    const t = S.maskCode(text || '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(S.LINK_RE, (m, b, target, h, l, alias) => alias || target)
      .replace(/^[#>\-*+\s]+|\[[ x]\]/gim, '')
      .replace(/[*_=~`]/g, '')
      .replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };
})(window.S);
