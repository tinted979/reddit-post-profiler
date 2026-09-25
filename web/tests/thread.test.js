// A covered post's commenters from the archive: the thread's rows in comments_by_link up to
// where the files end, plus the subreddit's tail after that (fetchTails), instead of the
// comment tree request.
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

// Subreddit-wide searches from `recent`, and the comment tree from `tree` ([author, time], …).
function api({ recent = {}, tree = [] }) {
  return (u) => {
    if (isTree(u)) {
      return json({ data: tree.map(([author, t], i) => ({ kind: "t1", data: { id: `k${i}`, author, created_utc: t, replies: "" } })) });
    }
    const after = Number(u.searchParams.get("after") ?? -Infinity);
    const rows = (recent[kindOf(u)] ?? []).filter((r) => r.created_utc > after).sort((a, b) => a.created_utc - b.created_utc);
    return json({ data: rows.slice(0, Number(u.searchParams.get("limit"))) });
  };
}

const asObject = (commenters) => Object.fromEntries(commenters);

test("with a tail that reached the present, the commenters come from comments_by_link and the tail, with no tree request", async () => {
  const recent = {
    comments: [
      { id: "c4", author: "carol", created_utc: 1699990000, link_id: "t3_p1" }, // in the files' last hour
      { id: "c9", author: "dave", created_utc: NOW - 100, link_id: "t3_p1" },
      { id: "c10", author: "erin", created_utc: NOW - 50, link_id: "t3_other" },
    ],
  };
  const { client, calls } = makeClient(api({ recent, tree: [["someone", 1]] }));
  const dumps = await openFixtures();
  await fetchTails(client, dumps, P1, { only: ["Python"], now: () => NOW });
  const before = calls.length;
  const commenters = await collectCommenters(client, P1, { dumps });
  assert.equal(calls.length, before, "no requests");
  assert.deepEqual(asObject(commenters), {
    Alice: { count: 1, last: 1699000000 },
    carol: { count: 1, last: 1699990000 },
    dave: { count: 1, last: NOW - 100 },
  });
});

test("a post newer than the files takes its commenters from the tail alone", async () => {
  const recent = {
    comments: [
      { id: "n1", author: "alice", created_utc: NEW_POST.createdUtc + 60, link_id: "t3_abc123" },
      { id: "n2", author: "bob", created_utc: NEW_POST.createdUtc + 120, link_id: "t3_abc123" },
      { id: "n3", author: "alice", created_utc: NEW_POST.createdUtc + 180, link_id: "t3_abc123" },
    ],
  };
  const { client, calls } = makeClient(api({ recent }));
  const dumps = await openFixtures();
  await fetchTails(client, dumps, NEW_POST, { now: () => NOW });
  const commenters = await collectCommenters(client, NEW_POST, { dumps });
  assert.equal(calls.filter(isTree).length, 0);
  assert.deepEqual(asObject(commenters), {
    alice: { count: 2, last: NEW_POST.createdUtc + 180 },
    bob: { count: 1, last: NEW_POST.createdUtc + 120 },
  });
});

test("skipped users and the OP apply to the archive's commenters as to the tree's", async () => {
  const recent = {
    comments: [
      { id: "n1", author: "alice", created_utc: NEW_POST.createdUtc + 60, link_id: "t3_abc123" },
      { id: "n2", author: "Bob", created_utc: NEW_POST.createdUtc + 120, link_id: "t3_abc123" },
    ],
  };
  const { client } = makeClient(api({ recent }));
  const dumps = await openFixtures();
  await fetchTails(client, dumps, NEW_POST, { now: () => NOW });
  const commenters = await collectCommenters(client, NEW_POST, { dumps, exclude: ["u/bob"], includeOp: true });
  assert.deepEqual(asObject(commenters), {
    alice: { count: 1, last: NEW_POST.createdUtc + 60 },
    op_user: { count: 0, last: null },
  });
});

test("without a tail that reached the present, the tree answers", async () => {
  const tree = [["alice", NEW_POST.createdUtc + 60]];
  // An old post in a full scan: no tail at all.
  const first = makeClient(api({ tree }));
  const old = await openFixtures();
  await fetchTails(first.client, old, P1, { now: () => NOW });
  await collectCommenters(first.client, P1, { dumps: old });
  assert.equal(first.calls.filter(isTree).length, 1);

  // A tail cut short by its budget.
  const many = Array.from({ length: 150 }, (_, i) => ({ id: `m${i}`, author: "dave", created_utc: COMMENTS_THROUGH + 60 * (i + 1), link_id: "t3_other" }));
  const second = makeClient(api({ recent: { comments: many }, tree }));
  const partial = await openFixtures();
  await fetchTails(second.client, partial, NEW_POST, { now: () => NOW, budget: 1 });
  const commenters = await collectCommenters(second.client, NEW_POST, { dumps: partial });
  assert.equal(second.calls.filter(isTree).length, 1);
  assert.deepEqual(asObject(commenters), { alice: { count: 1, last: NEW_POST.createdUtc + 60 } });
});

test("if comments_by_link can't be read, or isn't in the manifest, the tree answers", async () => {
  const tree = [["alice", NEW_POST.createdUtc + 60]];
  const failing = async (url) => {
    if (url.endsWith("comments_by_link.parquet")) throw new TypeError("Failed to fetch");
    return localFile(url);
  };
  const first = makeClient(api({ tree }));
  const dumps = await openFixtures({ openFile: failing });
  await fetchTails(first.client, dumps, NEW_POST, { now: () => NOW });
  assert.deepEqual(asObject(await collectCommenters(first.client, NEW_POST, { dumps })), { alice: { count: 1, last: NEW_POST.createdUtc + 60 } });
  assert.equal(first.calls.filter(isTree).length, 1);

  const sub = MANIFEST.subreddits.python;
  const { comments_by_link: _, ...files } = sub.files;
  const noLinkFile = { format: DUMP_FORMAT, subreddits: { python: { ...sub, files } } };
  const second = makeClient(api({ tree }));
  const without = await openFixtures({ manifest: noLinkFile });
  assert.ok(without.covers("python"), "the other files still cover the subreddit");
  await fetchTails(second.client, without, NEW_POST, { now: () => NOW });
  await collectCommenters(second.client, NEW_POST, { dumps: without });
  assert.equal(second.calls.filter(isTree).length, 1);
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
