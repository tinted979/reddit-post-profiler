// A covered post's commenters from the archive: for a post older than where the files end,
// the thread's rows in comments_by_link up to there, plus one request for the thread's
// comments after it; a newer post's thread comes from the comment tree.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ArcticShiftClient, INGEST_LAG, collectCommenters, fetchTails } from "../core.js";
import { DUMP_FORMAT, DumpSource } from "../dumps.js";

const FIX = new URL("./fixtures/dumps/", import.meta.url);
const BASE = "https://dumps.test";
const MANIFEST = JSON.parse(readFileSync(new URL("manifest.json", FIX), "utf8"));

function localBuffer(relPath) {
  const buf = readFileSync(new URL(relPath, FIX));
  return { byteLength: buf.byteLength, slice: (s, e = buf.byteLength) => buf.buffer.slice(buf.byteOffset + s, buf.byteOffset + e) };
}
const localFile = async (url) => localBuffer(url.slice(BASE.length + 1));
const openFixtures = ({ manifest = MANIFEST, ...opts } = {}) =>
  DumpSource.open({ baseUrl: BASE, fetchFn: async () => new Response(JSON.stringify(manifest)), openFile: localFile, ...opts });

// In the fixture r/Python files, post p1 (by Alice) has Alice's comment at 1699000000 and
// carol's at 1699990000, which falls in the files' last hour, so the tail fetches it again.
const COMMENTS_THROUGH = 1699990000 - INGEST_LAG;
const NOW = 1_700_100_000;
const P1 = { id: "p1", author: "Alice", subreddit: "Python", createdUtc: 1699900000, title: "p1", numComments: 3 };
const NEW_POST = { id: "abc123", author: "op_user", subreddit: "Python", createdUtc: 1_700_000_000, title: "t", numComments: 2 };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeClient(handler) {
  const calls = [];
  const clock = { t: NOW };
  const client = new ArcticShiftClient({
    delay: 0,
    fetchFn: async (url) => {
      const u = new URL(url);
      calls.push(u);
      return handler(u);
    },
    sleep: async (s) => { clock.t += s; },
    now: () => clock.t,
    random: () => 0.5,
  });
  return { client, calls };
}

const kindOf = (u) => (u.pathname.includes("/posts/") ? "posts" : "comments");
const isTree = (u) => u.pathname === "/api/comments/tree";

// Searches over `recent` (subreddit-wide, or one thread with `link_id`) honouring after,
// before and limit, and the comment tree from `tree` ([author, time], …).
function api({ recent = {}, tree = [] }) {
  return (u) => {
    if (isTree(u)) {
      return json({ data: tree.map(([author, t], i) => ({ kind: "t1", data: { id: `k${i}`, author, created_utc: t, replies: "" } })) });
    }
    const after = Number(u.searchParams.get("after") ?? -Infinity);
    const before = Number(u.searchParams.get("before") ?? Infinity);
    const link = u.searchParams.get("link_id");
    const rows = (recent[kindOf(u)] ?? [])
      .filter((r) => r.created_utc > after && r.created_utc < before && (link === null || r.link_id === `t3_${link}`))
      .sort((a, b) => a.created_utc - b.created_utc);
    return json({ data: rows.slice(0, Number(u.searchParams.get("limit"))) });
  };
}
const isThreadSearch = (u) => u.pathname === "/api/comments/search" && u.searchParams.has("link_id");

const asObject = (commenters) => Object.fromEntries(commenters);

test("a post older than the files: commenters from comments_by_link plus one request for the rest, with no tree request", async () => {
  const recent = {
    comments: [
      { id: "c4", author: "carol", created_utc: 1699990000, link_id: "t3_p1" }, // in the files' last hour
      { id: "c9", author: "dave", created_utc: NOW - 100, link_id: "t3_p1" },
      { id: "c10", author: "erin", created_utc: NOW - 50, link_id: "t3_other" },
    ],
  };
  const { client, calls } = makeClient(api({ recent, tree: [["someone", 1]] }));
  const dumps = await openFixtures();
  const commenters = await collectCommenters(client, P1, { dumps });
  assert.equal(calls.length, 1, "only the thread's comments after the files");
  assert.ok(isThreadSearch(calls[0]));
  assert.equal(calls[0].searchParams.get("after"), String(COMMENTS_THROUGH));
  assert.deepEqual(asObject(commenters), {
    Alice: { count: 1, last: 1699000000 },
    carol: { count: 1, last: 1699990000 },
    dave: { count: 1, last: NOW - 100 },
  });
});

test("a post newer than the files takes its commenters from the comment tree, tail or not", async () => {
  const tree = [["alice", NEW_POST.createdUtc + 60], ["bob", NEW_POST.createdUtc + 120], ["alice", NEW_POST.createdUtc + 180]];
  const { client, calls } = makeClient(api({ tree }));
  const dumps = await openFixtures();
  // The tail stops at the post, so it never has the thread's comments.
  await fetchTails(client, dumps, NEW_POST, { now: () => NOW });
  const commenters = await collectCommenters(client, NEW_POST, { dumps });
  assert.equal(calls.filter(isTree).length, 1);
  assert.equal(calls.filter(isThreadSearch).length, 0);
  assert.deepEqual(asObject(commenters), {
    alice: { count: 2, last: NEW_POST.createdUtc + 180 },
    bob: { count: 1, last: NEW_POST.createdUtc + 120 },
  });
});

test("skipped users and the OP apply to the archive's commenters as to the tree's", async () => {
  const recent = {
    comments: [
      { id: "n1", author: "dave", created_utc: NOW - 60, link_id: "t3_p1" },
      { id: "n2", author: "Bob", created_utc: NOW - 30, link_id: "t3_p1" },
    ],
  };
  const { client } = makeClient(api({ recent }));
  const post = { ...P1, author: "op_user" }; // p1's thread, from the files, with an OP who didn't comment
  const commenters = await collectCommenters(client, post, { dumps: await openFixtures(), exclude: ["u/bob"], includeOp: true });
  assert.deepEqual(asObject(commenters), {
    Alice: { count: 1, last: 1699000000 },
    dave: { count: 1, last: NOW - 60 },
    op_user: { count: 0, last: null },
  });
});

test("without the archive's files for the thread, the tree answers", async () => {
  const tree = [["alice", NEW_POST.createdUtc + 60]];
  // A subreddit the archive doesn't cover.
  const first = makeClient(api({ tree }));
  await collectCommenters(first.client, { ...NEW_POST, subreddit: "rust" }, { dumps: await openFixtures() });
  assert.equal(first.calls.filter(isTree).length, 1);

  // A post newer than the files, whatever the tail did: the files have none of the thread.
  const many = Array.from({ length: 150 }, (_, i) => ({ id: `m${i}`, author: "dave", created_utc: COMMENTS_THROUGH + 60 * (i + 1), link_id: "t3_other" }));
  const second = makeClient(api({ recent: { comments: many }, tree }));
  const partial = await openFixtures();
  await fetchTails(second.client, partial, NEW_POST, { now: () => NOW, budget: 1 });
  const commenters = await collectCommenters(second.client, NEW_POST, { dumps: partial });
  assert.equal(second.calls.filter(isTree).length, 1);
  assert.deepEqual(asObject(commenters), { alice: { count: 1, last: NEW_POST.createdUtc + 60 } });
});

test("if comments_by_link can't be read, or isn't in the manifest, the tree answers", async () => {
  // An old post, whose thread the files would otherwise give.
  const tree = [["alice", P1.createdUtc + 60]];
  const failing = async (url) => {
    if (url.endsWith("comments_by_link.parquet")) throw new TypeError("Failed to fetch");
    return localFile(url);
  };
  const first = makeClient(api({ tree }));
  const dumps = await openFixtures({ openFile: failing });
  assert.deepEqual(asObject(await collectCommenters(first.client, P1, { dumps })), { alice: { count: 1, last: P1.createdUtc + 60 } });
  assert.equal(first.calls.filter(isTree).length, 1);
  assert.equal(first.calls.filter(isThreadSearch).length, 0);

  const sub = MANIFEST.subreddits.python;
  const { comments_by_link: _, ...files } = sub.files;
  const noLinkFile = { format: DUMP_FORMAT, subreddits: { python: { ...sub, files } } };
  const second = makeClient(api({ tree }));
  const without = await openFixtures({ manifest: noLinkFile });
  assert.ok(without.covers("python"), "the other files still cover the subreddit");
  await collectCommenters(second.client, P1, { dumps: without });
  assert.equal(second.calls.filter(isTree).length, 1);
});

test("thread rows without an author, or with an empty one, are dropped", async () => {
  // Not something build_dumps.py writes: a file made by hand with DuckDB.
  const bad = readFileSync(new URL("./fixtures/malformed/comments_by_link.parquet", import.meta.url));
  const openFile = async (url) => (url.endsWith("comments_by_link.parquet")
    ? { byteLength: bad.byteLength, slice: (s, e = bad.byteLength) => bad.buffer.slice(bad.byteOffset + s, bad.byteOffset + e) }
    : localFile(url));
  const { client } = makeClient(api({}));
  const dumps = await openFixtures({ openFile });
  await fetchTails(client, dumps, P1, { only: ["Python"], now: () => NOW });
  assert.deepEqual(await dumps.threadRows("Python", "p1"), [{ author: "Alice", created_utc: 1699000001 }]);
});

test("a tail row dated more than a day ahead is dropped, and a cut-short tail never covers past now", async () => {
  const future = NOW + 10 * 86400;
  const rows = [
    ...Array.from({ length: 99 }, (_, i) => ({ id: `m${i}`, author: "dave", created_utc: COMMENTS_THROUGH + 60 * (i + 1), link_id: "t3_other" })),
    { id: "f1", author: "mallory", created_utc: future, link_id: "t3_other" },
    { id: "m99", author: "dave", created_utc: future + 1, link_id: "t3_other" },
  ];
  const { client } = makeClient(api({ recent: { comments: rows } }));
  const dumps = await openFixtures();
  await fetchTails(client, dumps, NEW_POST, { now: () => NOW, budget: 1 });
  assert.deepEqual(await dumps.timestamps("comments", "Python", "mallory"), []);
  assert.ok(dumps.covers("python").commentsThrough <= NOW);
});
