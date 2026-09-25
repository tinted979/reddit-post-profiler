// Saved data, in two IndexedDB stores:
// - "counts": results for buildProfile, so rescanning a thread (or scanning another one
//   with some of the same people) skips the API. Records are {value, fetchedAt}, with
//   fetchedAt in epoch seconds.
// - "scans": snapshots of finished (or stopped) scans, so they can be reopened without any
//   requests. See ScanStore.
// Saving is best-effort: if a store is missing, broken or hangs, it turns itself off and
// the run carries on without it.

const DAY = 86400;

// Stores copies (structuredClone), as IndexedDB does, so a record it couldn't store fails
// here too and callers can't change a stored record by changing their own object.
export class MemoryBackend {
  constructor() {
    this.map = new Map();
  }
  async get(key) {
    return this.map.get(key) ?? null;
  }
  async getMany(keys) {
    return keys.map((key) => this.map.get(key) ?? null);
  }
  async set(key, record) {
    this.map.set(key, structuredClone(record));
  }
  // Several [key, record] pairs, all or none.
  async setMany(entries) {
    const copies = entries.map(([key, record]) => [key, structuredClone(record)]);
    for (const [key, record] of copies) this.map.set(key, record);
  }
  async delete(key) {
    this.map.delete(key);
  }
  async deleteMany(keys) {
    for (const key of keys) this.map.delete(key);
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

// Named before the project became Reddit Post Profiler; kept so visitors' saved data survives.
const DB_NAME = "reddit-tool";
const DB_VERSION = 3; // 1: counts; 2: + scans; 3: + a fetchedAt index on counts
// When saved results were last pruned (epoch seconds), so it happens at most once a day.
// Named like the page's other localStorage keys.
export const PRUNE_KEY = "reddit-tool-pruned";
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
      // Saved results by when they were fetched, so pruning finds the old ones without
      // reading every record. A record without a numeric fetchedAt would never be found
      // (it's missing from the index, or sorts after every number), so drop those now, once.
      const counts = req.transaction.objectStore("counts");
      if (!counts.indexNames.contains("fetchedAt")) {
        counts.createIndex("fetchedAt", "fetchedAt");
        const cursor = counts.openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return;
          if (!Number.isFinite(c.value?.fetchedAt)) c.delete();
          c.continue();
        };
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

  // Run `fn(store)` in one transaction; resolves when it commits, with the result of the
  // request `fn` returns (or of each, for an array). If `fn` throws (a record that can't
  // be stored, say), the transaction is aborted so nothing it had queued is written.
  async _run(mode, fn) {
    const db = await openDb(this._idb);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this._store, mode);
      let req;
      try {
        req = fn(tx.objectStore(this._store));
      } catch (err) {
        tx.onabort = () => reject(err);
        tx.abort();
        return;
      }
      tx.oncomplete = () => resolve(Array.isArray(req) ? req.map((r) => r.result) : req?.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }

  async get(key) {
    return (await this._run("readonly", (s) => s.get(key))) ?? null;
  }

  async getMany(keys) {
    return (await this._run("readonly", (s) => keys.map((key) => s.get(key)))).map((v) => v ?? null);
  }

  async set(key, record) {
    await this._run("readwrite", (s) => s.put(record, key));
  }

  // Several [key, record] pairs in one transaction, so either all are saved or none.
  async setMany(entries) {
    await this._run("readwrite", (s) => {
      for (const [key, record] of entries) s.put(record, key);
      return null;
    });
  }

  async delete(key) {
    await this._run("readwrite", (s) => s.delete(key));
  }

  async deleteMany(keys) {
    await this._run("readwrite", (s) => {
      for (const key of keys) s.delete(key);
      return null;
    });
  }

  async getPrefix(prefix) {
    return this._run("readonly", (s) => s.getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`)));
  }

  async clear() {
    const n = await this._run("readonly", (s) => s.count());
    await this._run("readwrite", (s) => s.clear());
    return n;
  }

  // With the fetchedAt index (the counts store), only the keys of records fetched before
  // `cutoff` are walked, and nothing is read; without it, every record is.
  async prune(cutoff) {
    let n = 0;
    await this._run("readwrite", (s) => {
      const byTime = s.indexNames.contains("fetchedAt");
      const req = byTime ? s.index("fetchedAt").openKeyCursor(IDBKeyRange.upperBound(cutoff, true)) : s.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        if (byTime) {
          s.delete(cursor.primaryKey);
          n++;
        } else if (!(cursor.value?.fetchedAt >= cutoff)) {
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

// Backends that stopped answering. Kept here rather than on each store object, because
// app.js opens a new store for every action: once a backend hangs, every store using it
// stays off for the rest of the page's life instead of waiting out the timeout again.
const hungBackends = new WeakSet();

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
  }

  get enabled() {
    return this.ttl > 0 && !hungBackends.has(this.backend);
  }

  _call(fn) {
    return withTimeout(fn, this._timeoutMs, () => hungBackends.add(this.backend));
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

  // prune(), at most once a day (`storage`, localStorage by default, remembers when):
  // there's no need to look on every page load. Returns how many were deleted, or null if
  // it was skipped. Storage that can't be used doesn't stop it.
  async pruneDaily(storage = globalThis.localStorage) {
    let last = NaN;
    try {
      last = Number(storage?.getItem(PRUNE_KEY));
    } catch {
      // blocked: prune anyway
    }
    if (this._now() - last < DAY) return null;
    const n = await this.prune();
    try {
      storage?.setItem(PRUNE_KEY, String(this._now()));
    } catch {
      // blocked: prune again next time
    }
    return n;
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
  // A big scan's save (thousands of profiles to copy) can take seconds on a slow device,
  // so writes get longer than reads before the store counts as hung: giving up early would
  // report a save as failed that then goes through.
  constructor({ backend = new MemoryBackend(), timeoutMs = 3000, writeTimeoutMs = 30000 } = {}) {
    this.backend = backend;
    this._timeoutMs = timeoutMs;
    this._writeTimeoutMs = writeTimeoutMs;
  }

  async _call(fn, fallback, timeoutMs = this._timeoutMs) {
    if (hungBackends.has(this.backend)) return fallback;
    try {
      return await withTimeout(fn, timeoutMs, () => hungBackends.add(this.backend));
    } catch {
      return fallback;
    }
  }

  // Returns "saved"; "empty" (not written: no profile without an error, judged from the
  // profiles rather than an imported summary's stats); "kept" (not written: a stopped scan,
  // and a complete scan of the post is saved); or "failed" (storage full, blocked or
  // hung). Both records go in one transaction, so a failed save can't pair a scan's old
  // summary with new profiles.
  save(summary, profiles) {
    if (!profiles.some((p) => !p?.error)) return Promise.resolve("empty");
    return this._call(async () => {
      if (summary.complete !== true) {
        const saved = await this.backend.get(`sum|${summary.id}`);
        if (saved?.complete === true) return "kept";
      }
      await this.backend.setMany([[`data|${summary.id}`, { profiles }], [`sum|${summary.id}`, summary]]);
      return "saved";
    }, "failed", this._writeTimeoutMs);
  }

  // Summaries, newest scan first.
  async list() {
    const rows = await this._call(() => this.backend.getPrefix("sum|"), []);
    return rows.filter((r) => r && typeof r.id === "string" && Number.isFinite(r.scannedAt))
      .sort((a, b) => b.scannedAt - a.scannedAt);
  }

  // {summary, profiles} or null. Both records are read in one transaction, so a save from
  // another tab can't land between them.
  async load(id) {
    return this._call(async () => {
      const [summary, data] = await this.backend.getMany([`sum|${id}`, `data|${id}`]);
      return summary && Array.isArray(data?.profiles) ? { summary, profiles: data.profiles } : null;
    }, null);
  }

  // Both records in one transaction; returns whether it worked.
  delete(id) {
    return this._call(async () => {
      await this.backend.deleteMany([`sum|${id}`, `data|${id}`]);
      return true;
    }, false, this._writeTimeoutMs);
  }

  // Every scan as {summary, profiles}, newest first, for exporting; `failed` counts the
  // listed scans that couldn't be read.
  async exportAll() {
    const scans = [];
    let failed = 0;
    for (const summary of await this.list()) {
      const rec = await this.load(summary.id);
      if (rec) scans.push(rec);
      else failed++;
    }
    return { scans, failed };
  }

  // Save imported scans ({summary, profiles}, already checked). A scan of a post that's
  // saved here already replaces it only if it's newer. Returns {added, replaced, kept,
  // failed}.
  async importAll(scans) {
    const have = new Map((await this.list()).map((s) => [s.id, s.scannedAt]));
    const result = { added: 0, replaced: 0, kept: 0, failed: 0 };
    let stopped = false; // a save failed: storage is full or blocked, so try no more
    for (const { summary, profiles } of scans) {
      const when = have.get(summary.id);
      if (when !== undefined && when >= summary.scannedAt) {
        result.kept++;
        continue;
      }
      if (stopped) {
        result.failed++;
        continue;
      }
      const saved = await this.save(summary, profiles);
      if (saved === "failed") {
        result.failed++;
        stopped = true;
        continue;
      }
      if (saved === "kept" || saved === "empty") {
        result.kept++;
        continue;
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
