// Results cache for buildProfile, so rescanning a thread (or scanning another one with the
// same people) skips the API. Records are {value, fetchedAt} with fetchedAt in epoch
// seconds. Everything here is best-effort: a broken or missing store means no caching.

export class MemoryBackend {
  constructor() {
    this.map = new Map();
  }
  async get(key) {
    return this.map.get(key) ?? null;
  }
  async set(key, record) {
    this.map.set(key, record);
  }
  async clear() {
    const n = this.map.size;
    this.map.clear();
    return n;
  }
}

const DB_NAME = "reddit-tool";
const STORE = "counts";

export class IndexedDbBackend {
  constructor(idb = globalThis.indexedDB) {
    this._idb = idb;
    this._db = null;
  }

  _open() {
    this._db ??= new Promise((resolve, reject) => {
      const req = this._idb.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._db;
  }

  async _run(mode, fn) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }

  async get(key) {
    return (await this._run("readonly", (s) => s.get(key))) ?? null;
  }

  async set(key, record) {
    await this._run("readwrite", (s) => s.put(record, key));
  }

  async clear() {
    const n = await this._run("readonly", (s) => s.count());
    await this._run("readwrite", (s) => s.clear());
    return n;
  }
}

export class ProfileCache {
  constructor({ backend = new MemoryBackend(), ttlDays = 7, now = () => Date.now() / 1000 } = {}) {
    this.backend = backend;
    this.ttl = ttlDays * 86400;
    this._now = now;
    this.hits = 0;
  }

  get enabled() {
    return this.ttl > 0;
  }

  async get(key) {
    if (!this.enabled) return null;
    try {
      const rec = await this.backend.get(key);
      if (!rec || this._now() - rec.fetchedAt > this.ttl) return null;
      this.hits++;
      return rec;
    } catch {
      return null;
    }
  }

  async set(key, value) {
    if (!this.enabled) return;
    try {
      await this.backend.set(key, { value, fetchedAt: this._now() });
    } catch {
      // Out of quota or storage blocked: carry on uncached.
    }
  }

  // Number of entries removed.
  async clear() {
    try {
      return await this.backend.clear();
    } catch {
      return 0;
    }
  }
}

// The browser cache: IndexedDB when available, else in-memory for this page only.
export function openCache(ttlDays) {
  const backend = globalThis.indexedDB ? new IndexedDbBackend() : new MemoryBackend();
  return new ProfileCache({ backend, ttlDays });
}
