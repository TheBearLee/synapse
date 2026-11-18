/* Synapse — IndexedDB storage. Pages are cached in memory (S.pages Map). */
(function (S) {
  'use strict';
  const DB_NAME = 'synapse-vault';
  const VERSION = 1;
  let db;

  const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  S.pages = new Map();
  const attCache = new Map(); // id -> objectURL

  S.db = {
    async open() {
      db = await new Promise((res, rej) => {
        const r = indexedDB.open(DB_NAME, VERSION);
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains('pages')) d.createObjectStore('pages', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('attachments')) d.createObjectStore('attachments', { keyPath: 'id' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const all = await req2p(db.transaction('pages').objectStore('pages').getAll());
      S.pages.clear();
      for (const p of all) S.pages.set(p.id, normalize(p));
      return S.pages.size;
    },

    store(name, mode = 'readonly') { return db.transaction(name, mode).objectStore(name); },

    async putPage(p) {
      p.updated = p.updated || Date.now();
      S.pages.set(p.id, p);
      await req2p(this.store('pages', 'readwrite').put(p));
    },
    async deletePageHard(id) {
      S.pages.delete(id);
      await req2p(this.store('pages', 'readwrite').delete(id));
    },
    async putAttachment(blob, name) {
      const id = S.uid('att_');
      const rec = { id, blob, name: name || 'file', mime: blob.type, created: Date.now() };
      await req2p(this.store('attachments', 'readwrite').put(rec));
      return id;
    },
    async putAttachmentRecord(rec) {
      await req2p(this.store('attachments', 'readwrite').put(rec));
      attCache.delete(rec.id);
    },
    async getAttachment(id) {
      return req2p(this.store('attachments').get(id));
    },
    async attachmentKeys() {
      return req2p(this.store('attachments').getAllKeys());
    },
    async allAttachments() {
      return req2p(this.store('attachments').getAll());
    },
    async deleteAttachment(id) {
      attCache.delete(id);
      await req2p(this.store('attachments', 'readwrite').delete(id));
    },
    /** Resolve an attachment id to an object URL (cached). */
    async attURL(id) {
      if (attCache.has(id)) return attCache.get(id);
      const rec = await this.getAttachment(id);
      if (!rec) return null;
      const url = URL.createObjectURL(rec.blob);
      attCache.set(id, url);
      return url;
    },
    async clearAll() {
      await req2p(this.store('pages', 'readwrite').clear());
      await req2p(this.store('attachments', 'readwrite').clear());
      S.pages.clear();
      attCache.clear();
    },
  };

  function normalize(p) {
    p.props = p.props || {};
    p.type = p.type || 'note';
    p.content = p.content || '';
    p.parentId = p.parentId || null;
    return p;
  }
  S.normalizePage = normalize;

  S.newPage = (fields = {}) => normalize(Object.assign({
    id: S.uid('p_'),
    title: 'Untitled',
    icon: '',
    cover: null,
    type: 'note',
    parentId: null,
    content: '',
    props: {},
    favorite: false,
    deleted: false,
    created: Date.now(),
    updated: Date.now(),
  }, fields));

  /** Live (non-trashed) pages */
  S.livePages = () => [...S.pages.values()].filter((p) => !p.deleted);

  /** Fill <img data-att="id"> elements inside root with object URLs */
  S.hydrateImages = (root) => {
    root.querySelectorAll('[data-att]').forEach(async (el) => {
      const url = await S.db.attURL(el.dataset.att);
      if (!url) { el.classList.add('missing'); el.alt = 'Missing image'; return; }
      if (el.tagName === 'IMG') el.src = url; else el.style.backgroundImage = `url("${url}")`;
    });
  };
})(window.S);
