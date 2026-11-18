/* Synapse — backup, Markdown export (folder or .zip) and import. */
(function (S) {
  'use strict';

  const blobToB64 = (blob) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(blob); });
  const b64ToBlob = (b64, mime) => { const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new Blob([a], { type: mime }); };

  /* ---------- JSON backup ---------- */
  S.exportJSON = async () => {
    const atts = await S.db.allAttachments();
    const data = {
      app: 'synapse', version: 1, exported: new Date().toISOString(),
      pages: [...S.pages.values()],
      attachments: await Promise.all(atts.map(async (a) => ({ id: a.id, name: a.name, mime: a.mime, created: a.created, data: await blobToB64(a.blob) }))),
    };
    S.download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `synapse-backup-${S.isoDay()}.json`);
  };

  S.importJSON = async (file, replace) => {
    const data = JSON.parse(await file.text());
    if (data.app !== 'synapse' || !Array.isArray(data.pages)) throw new Error('Not a Synapse backup file');
    if (replace) await S.db.clearAll();
    for (const a of data.attachments || []) await S.db.putAttachmentRecord({ id: a.id, name: a.name, mime: a.mime, created: a.created, blob: b64ToBlob(a.data, a.mime) });
    for (const p of data.pages) await S.db.putPage(S.normalizePage(p));
    return data.pages.length;
  };

  /* ---------- Markdown export ---------- */
  const safeName = (s) => (s.replace(/[\\/:*?"<>|#^\[\]]/g, '').trim() || 'Untitled').slice(0, 120);
  const yamlVal = (v) => /^[\w .,'-]*$/.test(String(v)) ? String(v) : JSON.stringify(String(v));

  async function buildFiles() {
    const files = []; // {path, data: string|Blob}
    const atts = await S.db.allAttachments();
    const attPath = new Map(atts.map((a) => [a.id, `attachments/${a.id}-${safeName(a.name)}`]));
    for (const a of atts) files.push({ path: attPath.get(a.id), data: a.blob });
    const used = new Set();
    const pathOf = new Map();
    // folder per parent chain so the hierarchy survives
    const pages = S.livePages();
    for (const p of pages) {
      let name = safeName(p.title);
      let base = name, i = 2;
      while (used.has(base.toLowerCase())) base = `${name} (${i++})`;
      used.add(base.toLowerCase());
      pathOf.set(p.id, base);
    }
    for (const p of pages) {
      const fm = ['---', `title: ${yamlVal(p.title)}`, `id: ${p.id}`, `type: ${p.type}`];
      if (p.icon) fm.push(`icon: ${yamlVal(p.icon)}`);
      if (p.parentId && pathOf.has(p.parentId)) fm.push(`parent: "[[${S.pages.get(p.parentId).title}]]"`);
      if (p.cover && attPath.has(p.cover)) fm.push(`cover: ${attPath.get(p.cover)}`);
      for (const [k, v] of Object.entries(p.props)) if (v !== '' && v != null) fm.push(`${k}: ${yamlVal(v)}`);
      fm.push(`created: ${new Date(p.created).toISOString()}`, `updated: ${new Date(p.updated).toISOString()}`, '---', '');
      const body = (p.content || '').replace(/\(attachment:([\w]+)\)/g, (m, id) => attPath.has(id) ? `(${attPath.get(id)})` : m);
      files.push({ path: pathOf.get(p.id) + '.md', data: fm.join('\n') + body });
      if (p.type === 'canvas' && p.canvas) {
        // JSON Canvas-compatible export (jsoncanvas.org)
        const jc = {
          nodes: p.canvas.nodes.map((n) => {
            const base = { id: n.id, x: n.x, y: n.y, width: n.w, height: n.h };
            if (n.color) base.color = { red: '1', orange: '2', yellow: '3', green: '4', blue: '5', purple: '6' }[n.color];
            if (n.kind === 'page' && pathOf.has(n.pageId)) return { ...base, type: 'file', file: pathOf.get(n.pageId) + '.md' };
            if (n.kind === 'image' && attPath.has(n.attId)) return { ...base, type: 'file', file: attPath.get(n.attId) };
            return { ...base, type: 'text', text: n.text || '' };
          }),
          edges: p.canvas.edges.map((e) => ({ id: e.id, fromNode: e.from, toNode: e.to, fromSide: side(e.fromSide), toSide: side(e.toSide), label: e.label || undefined })),
        };
        files.push({ path: pathOf.get(p.id) + '.canvas', data: JSON.stringify(jc, null, 2) });
      }
    }
    return files;
  }
  const side = (s) => ({ t: 'top', r: 'right', b: 'bottom', l: 'left' })[s];

  S.exportMarkdown = async () => {
    const files = await buildFiles();
    if (window.showDirectoryPicker) {
      try {
        const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
        for (const f of files) {
          const parts = f.path.split('/');
          let d = dir;
          for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part, { create: true });
          const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
          const w = await fh.createWritable();
          await w.write(f.data);
          await w.close();
        }
        return `Exported ${files.length} files to “${dir.name}”`;
      } catch (e) {
        if (e.name === 'AbortError') return null;
        console.warn('Folder export failed, falling back to zip', e);
      }
    }
    const zip = await S.zip(files);
    S.download(zip, `synapse-markdown-${S.isoDay()}.zip`);
    return `Exported ${files.length} files as .zip`;
  };

  /* ---------- Markdown import ---------- */
  S.importMarkdownFiles = async (files) => {
    let n = 0;
    const parents = [];
    for (const f of files) {
      if (!/\.(md|markdown|txt)$/i.test(f.name)) continue;
      const { meta, body } = S.splitFrontmatter(await f.text());
      const title = meta.title || f.name.replace(/\.(md|markdown|txt)$/i, '');
      const p = S.newPage({ title, content: body, type: S.TYPES[meta.type] ? meta.type : 'note', icon: meta.icon || '' });
      const known = ['title', 'type', 'icon', 'id', 'created', 'updated', 'parent', 'cover'];
      for (const [k, v] of Object.entries(meta)) if (!known.includes(k)) p.props[k] = v;
      if (meta.created && !isNaN(Date.parse(meta.created))) p.created = Date.parse(meta.created);
      if (meta.parent) parents.push([p, meta.parent.replace(/^\[\[|\]\]$/g, '')]);
      const existing = S.findByTitle(title);
      if (existing && !existing.deleted) p.title = title + ' (imported)';
      await S.db.putPage(p);
      S.rebuildTitles();
      n++;
    }
    for (const [p, parentTitle] of parents) {
      const par = S.findByTitle(parentTitle);
      if (par && par.id !== p.id) { p.parentId = par.id; await S.db.putPage(p); }
    }
    return n;
  };

  /* ---------- minimal ZIP writer (store, no compression) ---------- */
  const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

  S.zip = async (files) => {
    const enc = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of files) {
      const name = enc.encode(f.path);
      const data = typeof f.data === 'string' ? enc.encode(f.data) : new Uint8Array(await f.data.arrayBuffer());
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      chunks.push(lh.buffer, name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(ch.buffer, name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, c) => s + (c.byteLength || c.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, end.buffer], { type: 'application/zip' });
  };
})(window.S);
