// Saved data, in two IndexedDB stores:
// - "counts": results for buildProfile, so rescanning a thread (or scanning another one
//   with some of the same people) skips the API. Records are {value, fetchedAt}, with
//   fetchedAt in epoch seconds.
// - "scans": snapshots of finished (or stopped) scans, so they can be reopened without any
//   requests. See ScanStore.
// Saving is best-effort: if a store is missing, broken or hangs, it turns itself off and
// the run carries on without it.

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
  async delete(key) {
    this.map.delete(key);
  }
  // Values of the keys starting with `prefix`.
  async getPrefix(prefix) {
    return [...this.map].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);
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
const DB_VERSION = 2; // 1: counts; 2: + scans
const STORES = ["counts", "scans"];

// One connection per IndexedDB factory, shared by every store.
const connections = new WeakMap();

function openDb(idb) {
  let conn = connections.get(idb);
  if (conn) return conn;
  conn = new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Make way for a newer version of the page in another tab; reopen on next use.
      db.onversionchange = () => {
        db.close();
        connections.delete(idb);
      };
      db.onclose = () => connections.delete(idb);
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("the saved-results database is in use by another tab"));
  });
  conn.catch(() => connections.delete(idb));
  connections.set(idb, conn);
  return conn;
}

export class IndexedDbBackend {
  constructor(store = "counts", idb = globalThis.indexedDB) {
    this._store = store;
    this._idb = idb;
  }

  // Run `fn(store)` in a transaction; resolves with the result of the request it returns.
  async _run(mode, fn) {
    const db = await openDb(this._idb);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this._store, mode);
      const req = fn(tx.objectStore(this._store));
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

  async delete(key) {
    await this._run("readwrite", (s) => s.delete(key));
  }

  async getPrefix(prefix) {
    return this._run("readonly", (s) => s.getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`)));
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

// Run a backend call, but give up on a store that doesn't answer, so a stuck database
// can't stall the page. `onHang` is called when it gives up.
async function withTimeout(fn, ms, onHang) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(HUNG), ms);
  });
  try {
    const result = await Promise.race([fn(), timeout]);
    if (result === HUNG) {
      onHang();
      throw new Error("saved results aren't responding");
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

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

  _call(fn) {
    return withTimeout(fn, this._timeoutMs, () => (this._hung = true));
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

// Saved scans. Each is two records, so the list can be read without loading every
// profile: "sum|<post id>" (the summary shown in the list) and "data|<post id>"
// ({profiles}, as serializeProfile rows). A new scan of a post replaces the old one.
// Scans are kept until deleted, or cleared with the rest of the saved results.
export class ScanStore {
  constructor({ backend = new MemoryBackend(), timeoutMs = 3000 } = {}) {
    this.backend = backend;
    this._timeoutMs = timeoutMs;
    this._hung = false;
  }

  async _call(fn, fallback) {
    if (this._hung) return fallback;
    try {
      return await withTimeout(fn, this._timeoutMs, () => (this._hung = true));
    } catch {
      return fallback;
    }
  }

  // Returns true if saved.
  save(summary, profiles) {
    return this._call(async () => {
      await this.backend.set(`data|${summary.id}`, { profiles });
      await this.backend.set(`sum|${summary.id}`, summary);
      return true;
    }, false);
  }

  // Summaries, newest scan first.
  async list() {
    const rows = await this._call(() => this.backend.getPrefix("sum|"), []);
    return rows.filter((r) => r && typeof r.id === "string" && Number.isFinite(r.scannedAt))
      .sort((a, b) => b.scannedAt - a.scannedAt);
  }

  // {summary, profiles} or null.
  async load(id) {
    return this._call(async () => {
      const [summary, data] = await Promise.all([this.backend.get(`sum|${id}`), this.backend.get(`data|${id}`)]);
      return summary && Array.isArray(data?.profiles) ? { summary, profiles: data.profiles } : null;
    }, null);
  }

  delete(id) {
    return this._call(async () => {
      await this.backend.delete(`sum|${id}`);
      await this.backend.delete(`data|${id}`);
    });
  }

  // Every scan as {summary, profiles}, newest first, for exporting.
  async exportAll() {
    const out = [];
    for (const summary of await this.list()) {
      const rec = await this.load(summary.id);
      if (rec) out.push(rec);
    }
    return out;
  }

  // Save imported scans ({summary, profiles}, already checked). A scan of a post that's
  // saved here already replaces it only if it's newer. Returns {added, replaced, kept,
  // failed}.
  async importAll(scans) {
    const have = new Map((await this.list()).map((s) => [s.id, s.scannedAt]));
    const result = { added: 0, replaced: 0, kept: 0, failed: 0 };
    for (const [i, { summary, profiles }] of scans.entries()) {
      const when = have.get(summary.id);
      if (when !== undefined && when >= summary.scannedAt) {
        result.kept++;
        continue;
      }
      if (!(await this.save(summary, profiles))) {
        result.failed = scans.length - i; // storage full or blocked: stop here
        break;
      }
      have.set(summary.id, summary.scannedAt);
      result[when === undefined ? "added" : "replaced"]++;
    }
    return result;
  }

  // Delete every scan; returns how many there were.
  clear() {
    return this._call(async () => {
      const n = (await this.backend.getPrefix("sum|")).length;
      await this.backend.clear();
      return n;
    }, 0);
  }
}

const shared = {};

// The page's stores: IndexedDB when available, else memory (kept until the page closes).
// Every call shares one database connection.
function backend(store) {
  shared[store] ??= globalThis.indexedDB ? new IndexedDbBackend(store) : new MemoryBackend();
  return shared[store];
}

export function openCache(ttlDays) {
  return new ProfileCache({ backend: backend("counts"), ttlDays });
}

export function openScans() {
  return new ScanStore({ backend: backend("scans") });
}
