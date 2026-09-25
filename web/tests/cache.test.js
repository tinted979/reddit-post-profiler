// The storage backends and ScanStore, run against both MemoryBackend and the real
// IndexedDbBackend (on fake-indexeddb, a spec-following in-memory IndexedDB).
import assert from "node:assert/strict";
import { test } from "node:test";

import "fake-indexeddb/auto"; // IDBKeyRange and friends as globals, as in a browser
import { IDBFactory } from "fake-indexeddb";

import { IndexedDbBackend, MemoryBackend, ProfileCache, ScanStore } from "../cache.js";

const BACKENDS = {
  memory: () => new MemoryBackend(),
  // A fresh factory is a fresh, empty browser profile.
  indexeddb: (store = "scans", idb = new IDBFactory()) => new IndexedDbBackend(store, idb),
};

for (const [name, make] of Object.entries(BACKENDS)) {
  test(`${name}: get, set, delete and getPrefix`, async () => {
    const b = make();
    assert.equal(await b.get("missing"), null);
    await b.set("sum|a", { n: 1 });
    await b.set("sum|b", { n: 2 });
    await b.set("sum", { n: 3 }); // not under "sum|"
    await b.set("sun|x", { n: 4 }); // just past the prefix
    assert.deepEqual(await b.get("sum|a"), { n: 1 });
    assert.deepEqual((await b.getPrefix("sum|")).map((r) => r.n).sort(), [1, 2]);
    await b.delete("sum|a");
    assert.equal(await b.get("sum|a"), null);
  });

  test(`${name}: getMany and deleteMany`, async () => {
    const b = make();
    await b.setMany([["a", { n: 1 }], ["b", { n: 2 }]]);
    assert.deepEqual(await b.getMany(["a", "missing", "b"]), [{ n: 1 }, null, { n: 2 }]);
    await b.deleteMany(["a", "b", "missing"]);
    assert.deepEqual(await b.getMany(["a", "b"]), [null, null]);
  });

  test(`${name}: setMany saves all or nothing`, async () => {
    const b = make();
    await b.set("keep", { n: 0 });
    // A function can't be stored (DataCloneError in IndexedDB), so the batch fails...
    await assert.rejects(b.setMany([["a", { n: 1 }], ["b", { f() {} }]]));
    // ...and leaves nothing half-written.
    assert.deepEqual(await b.getMany(["a", "b", "keep"]), [null, null, { n: 0 }]);
  });

  test(`${name}: clear and prune count what they delete`, async () => {
    const b = make("counts");
    await b.setMany([["new", { fetchedAt: 100 }], ["edge", { fetchedAt: 50 }], ["old", { fetchedAt: 10 }], ["older", { fetchedAt: 5 }]]);
    assert.equal(await b.prune(50), 2); // fetched before the cutoff
    assert.deepEqual(await b.getMany(["new", "edge", "old", "older"]), [{ fetchedAt: 100 }, { fetchedAt: 50 }, null, null]);
    assert.equal(await b.clear(), 2);
    assert.equal(await b.get("new"), null);
  });

  test(`${name}: ScanStore deletes a scan's two records together and says so`, async () => {
    const store = new ScanStore({ backend: make() });
    await store.save({ id: "p1", scannedAt: 1, complete: true }, [{ error: null }]);
    assert.equal(await store.delete("p1"), true);
    assert.deepEqual(await store.backend.getMany(["sum|p1", "data|p1"]), [null, null]);
  });
}

test("ScanStore.delete reports a failure instead of claiming success", async () => {
  const backend = new MemoryBackend();
  backend.deleteMany = async () => {
    throw new Error("quota");
  };
  assert.equal(await new ScanStore({ backend }).delete("p1"), false);
});

test("ScanStore.load reads a scan's two records in one go", async () => {
  const backend = new MemoryBackend();
  let reads = 0;
  const getMany = backend.getMany.bind(backend);
  backend.getMany = (keys) => (reads++, getMany(keys));
  backend.get = () => assert.fail("load read the records one at a time");
  const store = new ScanStore({ backend });
  await store.save({ id: "p1", scannedAt: 1, complete: true }, [{ error: null }]);
  assert.deepEqual((await store.load("p1")).profiles, [{ error: null }]);
  assert.equal(reads, 1);
});

test("a slow save that finishes is reported as saved, not as a hung store", async () => {
  const backend = new MemoryBackend();
  const setMany = backend.setMany.bind(backend);
  backend.setMany = (entries) => new Promise((r) => setTimeout(r, 60)).then(() => setMany(entries));
  // Reads give up after 10 ms; a big scan's write is allowed longer.
  const store = new ScanStore({ backend, timeoutMs: 10, writeTimeoutMs: 1000 });
  assert.equal(await store.save({ id: "p1", scannedAt: 1, complete: true }, [{ error: null }]), "saved");
  assert.equal((await store.list()).length, 1); // and the store wasn't switched off
});

test("importAll counts the scans after a failed save as kept or failed, not all failed", async () => {
  const backend = new MemoryBackend();
  const store = new ScanStore({ backend });
  const scan = (id, scannedAt) => ({ summary: { id, scannedAt, complete: true }, profiles: [{ error: null }] });
  await store.save(scan("have", 500).summary, scan("have", 500).profiles);
  backend.setMany = async () => {
    throw new Error("quota");
  };
  // The first new scan fails to save; after that nothing more is tried, but "have" (older
  // than the copy here) is still counted as kept, and only "other" as failed.
  assert.deepEqual(await store.importAll([scan("new", 1), scan("have", 100), scan("other", 1)]),
    { added: 0, replaced: 0, kept: 1, failed: 2 });
});

test("the real database is created with both stores, and an old one gains the scans store", async () => {
  const idb = new IDBFactory();
  // A visitor from before saved scans: version 1, counts only, with a saved result.
  await new Promise((resolve, reject) => {
    const req = idb.open("reddit-tool", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("counts");
    req.onsuccess = () => {
      const tx = req.result.transaction("counts", "readwrite");
      tx.objectStore("counts").put({ value: 1, fetchedAt: 5 }, "v1|life|alice|all");
      tx.oncomplete = () => (req.result.close(), resolve());
    };
    req.onerror = () => reject(req.error);
  });
  const counts = new IndexedDbBackend("counts", idb);
  const scans = new IndexedDbBackend("scans", idb);
  assert.deepEqual(await counts.get("v1|life|alice|all"), { value: 1, fetchedAt: 5 }); // kept
  await scans.set("sum|p1", { id: "p1" });
  assert.deepEqual(await scans.get("sum|p1"), { id: "p1" });
});

test("a newer version of the page in another tab isn't blocked by this one", async () => {
  const idb = new IDBFactory();
  const backend = new IndexedDbBackend("counts", idb);
  await backend.set("k", { fetchedAt: 1 }); // this tab has the database open
  const upgraded = await new Promise((resolve, reject) => {
    const req = idb.open("reddit-tool", 4); // the other tab's newer page (this one is 3)
    req.onupgradeneeded = () => {};
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("blocked by the older tab"));
  });
  assert.equal(upgraded.version, 4);
  upgraded.close();
  // The older tab can't use the newer database; its store fails and ProfileCache carries on.
  const cache = new ProfileCache({ backend, ttlDays: 7 });
  assert.equal(await cache.get("k"), null);
});

// Opens the test's database directly, to look at what the page's code made of it.
const openRaw = (idb) => new Promise((resolve, reject) => {
  const req = idb.open("reddit-tool");
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

test("the saved-results store is indexed by fetchedAt, so prune needn't read every record", async () => {
  const idb = new IDBFactory();
  const counts = new IndexedDbBackend("counts", idb);
  await counts.set("k", { value: 1, fetchedAt: 5 });
  const db = await openRaw(idb);
  assert.equal(db.version, 3);
  assert.ok(db.transaction("counts").objectStore("counts").indexNames.contains("fetchedAt"));
  db.close();
});

test("upgrading a version 2 database adds the index and drops records it can't find", async () => {
  const idb = new IDBFactory();
  await new Promise((resolve, reject) => {
    const req = idb.open("reddit-tool", 2);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("counts");
      req.result.createObjectStore("scans");
    };
    req.onsuccess = () => {
      const tx = req.result.transaction(["counts", "scans"], "readwrite");
      const c = tx.objectStore("counts");
      c.put({ value: 1, fetchedAt: 100 }, "new");
      c.put({ value: 2, fetchedAt: 10 }, "old");
      c.put({ value: 3 }, "no-time"); // never written by this page, but old data can be odd
      c.put({ value: 4, fetchedAt: "soon" }, "odd-time");
      tx.objectStore("scans").put({ id: "p1" }, "sum|p1");
      tx.oncomplete = () => (req.result.close(), resolve());
    };
    req.onerror = () => reject(req.error);
  });
  const counts = new IndexedDbBackend("counts", idb);
  // Records the index can't see would never be pruned, so the upgrade drops them.
  assert.deepEqual(await counts.getMany(["new", "old", "no-time", "odd-time"]),
    [{ value: 1, fetchedAt: 100 }, { value: 2, fetchedAt: 10 }, null, null]);
  assert.deepEqual(await new IndexedDbBackend("scans", idb).get("sum|p1"), { id: "p1" }); // saved scans untouched
  assert.equal(await counts.prune(50), 1);
});

class FakeStorage {
  constructor() {
    this.data = new Map();
  }
  getItem(k) {
    return this.data.get(k) ?? null;
  }
  setItem(k, v) {
    this.data.set(k, String(v));
  }
}

test("pruneDaily prunes at most once a day", async () => {
  const clock = { t: 100 * 86400 };
  const backend = new MemoryBackend();
  const cache = new ProfileCache({ backend, ttlDays: 7, now: () => clock.t });
  const storage = new FakeStorage();
  await backend.set("old", { fetchedAt: clock.t - 40 * 86400 });
  assert.equal(await cache.pruneDaily(storage), 1);
  await backend.set("old2", { fetchedAt: clock.t - 40 * 86400 });
  clock.t += 3600;
  assert.equal(await cache.pruneDaily(storage), null); // pruned an hour ago: skipped
  assert.ok(await backend.get("old2"));
  clock.t += 86400;
  assert.equal(await cache.pruneDaily(storage), 1);
  // Storage that can't be read or written (blocked) doesn't stop pruning.
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(await cache.pruneDaily(blocked), 0);
});
