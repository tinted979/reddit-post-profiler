import assert from "node:assert/strict";
import { test } from "node:test";

import { LinkQueue, splitRefs } from "../queue.js";

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

test("adds post links, skipping duplicates and reporting bad ones", () => {
  const q = new LinkQueue({ storage: new FakeStorage() });
  const r = q.add("https://www.reddit.com/r/x/comments/abc123/t/\nhttps://redd.it/def456, abc123\nnonsense!", { years: 5 });
  assert.deepEqual(r, { added: 2, duplicates: 1, invalid: ["nonsense!"] });
  assert.deepEqual(q.items.map((i) => [i.postId, i.status, i.opts.years]), [["abc123", "waiting", 5], ["def456", "waiting", 5]]);
  // Once finished, the same post can be queued again.
  q.update(q.items[0].id, { status: "done" });
  assert.equal(q.add("abc123", {}).added, 1);
});

test("runs in order, retries at the end, removes and clears finished", () => {
  const q = new LinkQueue({ storage: new FakeStorage() });
  q.add("aaa111 bbb222 ccc333", {});
  const [a, b, c] = q.items;
  assert.equal(q.next(), a);
  q.update(a.id, { status: "failed", note: "boom" });
  assert.equal(q.next(), b);
  q.retry(a.id);
  assert.deepEqual(q.items.map((i) => i.postId), ["bbb222", "ccc333", "aaa111"]);
  assert.equal(q.get(a.id).status, "waiting");
  q.update(b.id, { status: "running" });
  q.remove(b.id); // not while it's running
  assert.ok(q.get(b.id));
  q.update(b.id, { status: "done" });
  q.remove(c.id);
  q.clearFinished();
  assert.deepEqual(q.items.map((i) => i.postId), ["aaa111"]);
  assert.deepEqual(q.counts(), { waiting: 1, running: 0, done: 0, failed: 0, stopped: 0, total: 1 });
});

test("survives a reload; a scan cut off mid-run goes back to waiting", () => {
  const storage = new FakeStorage();
  const q = new LinkQueue({ storage });
  q.add("aaa111 bbb222", { only: ["rust"] });
  q.setActive(true);
  q.update(q.items[0].id, { status: "running" });

  const again = new LinkQueue({ storage });
  assert.equal(again.load(), true); // it was cut off
  assert.equal(again.active, false); // and waits to be started again
  assert.deepEqual(again.items.map((i) => [i.postId, i.status, i.opts.only[0]]), [["aaa111", "waiting", "rust"], ["bbb222", "waiting", "rust"]]);
  again.add("ccc333", {});
  assert.equal(new Set(again.items.map((i) => i.id)).size, 3); // ids stay unique

  const idle = new LinkQueue({ storage: new FakeStorage() });
  assert.equal(idle.load(), false);
});

test("copes with broken or blocked storage", () => {
  const broken = new FakeStorage();
  broken.setItem("reddit-tool-queue", "{not json");
  const q = new LinkQueue({ storage: broken });
  assert.equal(q.load(), false);
  assert.deepEqual(q.items, []);
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const q2 = new LinkQueue({ storage: blocked });
  q2.load();
  assert.equal(q2.add("aaa111", {}).added, 1);
});

test("splitRefs splits lines, commas, and spaces between links only", () => {
  assert.deepEqual(splitRefs("https://redd.it/a1 https://redd.it/b2\nabc123, def456\n\n  not a link \nghi789 t3_1l7d1e4"),
    ["https://redd.it/a1", "https://redd.it/b2", "abc123", "def456", "not a link", "ghi789", "t3_1l7d1e4"]);
});
