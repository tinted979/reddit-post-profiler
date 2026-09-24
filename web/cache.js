// Saved results for buildProfile, so rescanning a thread (or scanning another one with
// some of the same people) skips the API. Records are {value, fetchedAt}, with fetchedAt
// in epoch seconds. Saving is best-effort: if the store is missing, broken or hangs, the
// cache turns itself off and the run carries on without it.

const DAY = 86400;

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
  // Delete records fetched before `cutoff` (epoch seconds); returns how many.
  async prune(cutoff) {
    let n = 0;
    for (const [key, rec] of this.map) {
      if (!(rec?.fetchedAt >= cutoff)) {
        this.map.delete(key);
        n++;
      }
    }
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
      req.onsuccess = () => {
        const db = req.result;
        // Make way for a newer version of the page in another tab; reopen on next use.
        db.onversionchange = () => {
          db.close();
          this._db = null;
        };
        db.onclose = () => {
          this._db = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("the saved-results database is in use by another tab"));
    });
    return this._db;
  }

  // Run `fn(store)` in a transaction; resolves with the result of the request it returns.
  async _run(mode, fn) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
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

  async prune(cutoff) {
    let n = 0;
    await this._run("readwrite", (s) => {
      const req = s.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        if (!(cursor.value?.fetchedAt >= cutoff)) {
          cursor.delete();
          n++;
        }
        cursor.continue();
      };
      return null;
    });
    return n;
  }
}

const HUNG = Symbol("hung");

export class ProfileCache {
  constructor({ backend = new MemoryBackend(), ttlDays = 7, now = () => Date.now() / 1000, timeoutMs = 3000 } = {}) {
    this.backend = backend;
    this.ttl = ttlDays * DAY;
    this._now = now;
    this._timeoutMs = timeoutMs;
    this._hung = false;
  }

  get enabled() {
    return this.ttl > 0 && !this._hung;
  }

  // Run a backend call, but give up on a store that doesn't answer (and stop using it),
  // so a stuck database can't stall a run.
  async _call(fn) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(HUNG), this._timeoutMs);
    });
    try {
      const result = await Promise.race([fn(), timeout]);
      if (result === HUNG) {
        this._hung = true;
        throw new Error("saved results aren't responding");
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  async get(key) {
    if (!this.enabled) return null;
    try {
      const rec = await this._call(() => this.backend.get(key));
      // Records without a usable fetchedAt count as expired.
      return rec && this._now() - rec.fetchedAt <= this.ttl ? rec : null;
    } catch {
      return null;
    }
  }

  async set(key, value) {
    if (!this.enabled) return;
    try {
      await this._call(() => this.backend.set(key, { value, fetchedAt: this._now() }));
    } catch {
      // Out of quota, or storage blocked: carry on without saving.
    }
  }

  // Delete everything; returns how many records there were.
  async clear() {
    try {
      return await this._call(() => this.backend.clear());
    } catch {
      return 0;
    }
  }

  // Delete records older than `maxAgeDays` (default: the TTL, but at least 30 days, so
  // results kept for a longer TTL next time aren't lost); returns how many.
  async prune(maxAgeDays = Math.max(this.ttl / DAY, 30)) {
    try {
      return await this._call(() => this.backend.prune(this._now() - maxAgeDays * DAY));
    } catch {
      return 0;
    }
  }
}

let shared = null;

// The page's cache: IndexedDB when available, else memory (kept until the page closes).
// Every call shares one store and one database connection.
export function openCache(ttlDays) {
  shared ??= globalThis.indexedDB ? new IndexedDbBackend() : new MemoryBackend();
  return new ProfileCache({ backend: shared, ttlDays });
}
