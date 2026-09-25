// The shared tail: a covered subreddit's activity after its archive files end, fetched once
// per scan (core.js fetchTails) and kept for the tab (dumps.js TailStore), so commenters
// don't each ask Arctic Shift about the same window.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ArcticShiftClient, INGEST_LAG, ServerBusy, buildProfile, fetchTails, tailBudget } from "../core.js";
import { DUMP_FORMAT, DumpSource, TailStore } from "../dumps.js";

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

// The fixture r/Python files are trusted to an hour before their newest items. Alice has
// comments at 1698000000, 1699000000 and 1699500000 and a post at 1699900000; carol's
// comment at 1699990000 falls in the files' last hour.
const POSTS_THROUGH = 1699950000 - INGEST_LAG;
const COMMENTS_THROUGH = 1699990000 - INGEST_LAG;
const ALICE_FILE_COMMENTS = [1698000000, 1699000000, 1699500000];
const NOW = 1_700_100_000;
const POST = { id: "abc123", author: "op_user", subreddit: "Python", createdUtc: 1_700_000_000, title: "t", numComments: 40 };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// A client served by `handler(url)`, on a simulated clock. Records every URL.
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
// A subreddit-wide search: no author or thread, just the subreddit's activity after a time.
const isTail = (u) => u.pathname.endsWith("/search") && u.searchParams.has("subreddit") &&
  !u.searchParams.has("author") && !u.searchParams.has("link_id");

// Arctic Shift's answer to a subreddit-wide search over `recent[kind]`: rows after `after`
// (exclusive), oldest first, `limit` at a time.
function tailRows(u, recent) {
  const after = Number(u.searchParams.get("after") ?? -Infinity);
  const rows = (recent[kindOf(u)] ?? []).filter((r) => r.created_utc > after).sort((a, b) => a.created_utc - b.created_utc);
  return json({ data: rows.slice(0, Number(u.searchParams.get("limit"))) });
}

// `n` comments by `author` in r/Python, one a minute from `from` on.
const minutely = (n, from, author = "dave") =>
  Array.from({ length: n }, (_, i) => ({ id: `m${i}`, author, created_utc: from + 60 * i, link_id: "t3_other" }));

test("tailBudget scales with the thread, from 2 to 20 pages", () => {
  assert.equal(tailBudget(0), 2);
  assert.equal(tailBudget(40), 2);
  assert.equal(tailBudget(250), 5);
  assert.equal(tailBudget(100_000), 20);
});

test("iterAscending pages from params.after, yielding each page's new rows", async () => {
  const rows = minutely(150, 5_000);
  const { client, calls } = makeClient((u) => tailRows(u, { comments: rows }));
  const pages = [];
  for await (const page of client.iterAscending("/api/comments/search", { subreddit: "Python", after: 4_999 }, 100)) pages.push(page);
  assert.deepEqual(pages.map((p) => p.length), [100, 50]); // the second page's repeat of row 99 is dropped
  assert.equal(calls[0].searchParams.get("after"), "4999");
  assert.equal(calls[1].searchParams.get("after"), String(rows[99].created_utc - 1));
  assert.equal(calls.length, 2, "a short page ends it");
});

test("the tail is one subreddit-wide search per kind after the files end, and extends the archive to now", async () => {
  const recent = {
    comments: [
      { id: "c5", author: "Alice", created_utc: COMMENTS_THROUGH + 10, link_id: "t3_p9" },
      { id: "c6", author: "dave", created_utc: POST.createdUtc - 100, link_id: "t3_p9" },
    ],
  };
  const { client, calls } = makeClient((u) => tailRows(u, recent));
  const dumps = await openFixtures();
  await fetchTails(client, dumps, POST, { now: () => NOW });

  assert.equal(calls.length, 2);
  assert.ok(calls.every(isTail));
  const byKind = Object.fromEntries(calls.map((u) => [kindOf(u), u.searchParams]));
  assert.equal(byKind.posts.get("after"), String(POSTS_THROUGH));
  assert.equal(byKind.comments.get("after"), String(COMMENTS_THROUGH));
  assert.equal(byKind.comments.get("subreddit"), "Python");
  assert.equal(byKind.comments.get("sort"), "asc");
  assert.equal(byKind.comments.get("limit"), "100");
  assert.equal(byKind.comments.get("fields"), "id,author,created_utc,link_id");
  assert.equal(byKind.posts.get("fields"), "id,author,created_utc");

  assert.equal(dumps.isCurrent("python"), true);
  assert.deepEqual(dumps.covers("PYTHON"), { name: "Python", postsThrough: NOW, commentsThrough: NOW });
  assert.deepEqual(await dumps.timestamps("comments", "Python", "alice"), [...ALICE_FILE_COMMENTS, COMMENTS_THROUGH + 10]);
  assert.deepEqual(await dumps.timestamps("comments", "Python", "DAVE"), [POST.createdUtc - 100]);
});

test("covers can say where the files alone end, for the end-of-scan note", async () => {
  const { client } = makeClient((u) => tailRows(u, {}));
  const dumps = await openFixtures();
  await fetchTails(client, dumps, POST, { now: () => NOW });
  assert.deepEqual(dumps.covers("python", { withTail: false }), { name: "Python", postsThrough: POSTS_THROUGH, commentsThrough: COMMENTS_THROUGH });
});

test("a row in the files' last hour counts once when the tail fetches it again", async () => {
  const recent = { comments: [{ id: "c4", author: "carol", created_utc: 1699990000, link_id: "t3_p1" }] };
  const { client } = makeClient((u) => tailRows(u, recent));
  const dumps = await openFixtures();
  await fetchTails(client, dumps, POST, { now: () => NOW });
  assert.deepEqual(await dumps.timestamps("comments", "Python", "carol"), [1699990000]);
});

test("the tail leaves out deleted accounts, AutoModerator and repeats", async () => {
  const t = COMMENTS_THROUGH + 100;
  const recent = {
    comments: [
      { id: "d1", author: "[deleted]", created_utc: t, link_id: "t3_x" },
      { id: "d2", author: "AutoModerator", created_utc: t + 1, link_id: "t3_x" },
      { id: "d3", author: "eve", created_utc: t + 2, link_id: "t3_x" },
      { id: "d3", author: "eve", created_utc: t + 2, link_id: "t3_x" },
    ],
  };
  const { client } = makeClient((u) => tailRows(u, recent));
  const dumps = await openFixtures();
  await fetchTails(client, dumps, POST, { now: () => NOW });
  assert.deepEqual(await dumps.timestamps("comments", "Python", "eve"), [t + 2]);
  assert.deepEqual(await dumps.timestamps("comments", "Python", "automoderator"), []);
  assert.deepEqual(await dumps.timestamps("comments", "Python", "[deleted]"), []);
});

test("a budget stops the tail early: it covers up to the last whole second it saw", async () => {
  const rows = minutely(250, COMMENTS_THROUGH + 60);
  const { client, calls } = makeClient((u) => tailRows(u, { comments: rows }));
  const dumps = await openFixtures();
  await fetchTails(client, dumps, POST, { now: () => NOW, budget: 2 });
  assert.equal(calls.filter((u) => kindOf(u) === "comments").length, 2);
  assert.equal(dumps.isCurrent("python"), false);
  const seen = rows[198].created_utc; // the second page repeats row 99, so it ends at row 198
  assert.equal(dumps.covers("python").commentsThrough, seen - 1);
  assert.equal((await dumps.timestamps("comments", "Python", "dave")).length, 199);
});

test("a busy server fails the scan rather than falling back to per-user requests", async () => {
  const { client } = makeClient(() => json({ error: "Timeout. Maybe slow down a bit" }, 422));
  const dumps = await openFixtures();
  await assert.rejects(fetchTails(client, dumps, POST, { now: () => NOW }), ServerBusy);
});

test("a query that times out leaves the files' cutoff for the per-user path", async () => {
  const { client } = makeClient(() => json({ error: "Query timed out" }, 422));
  const dumps = await openFixtures();
  await fetchTails(client, dumps, POST, { now: () => NOW });
  assert.equal(dumps.isCurrent("python"), false);
  assert.deepEqual(dumps.covers("python"), { name: "Python", postsThrough: POSTS_THROUGH, commentsThrough: COMMENTS_THROUGH });
});

test("no tail when the post is older than the files and the scan isn't limited to covered subreddits", async () => {
  const { client, calls } = makeClient((u) => tailRows(u, {}));
  const dumps = await openFixtures();
  const old = { ...POST, createdUtc: POSTS_THROUGH - 86400 };
  await fetchTails(client, dumps, old, { now: () => NOW });
  await fetchTails(client, dumps, old, { only: ["Python", "rust"], now: () => NOW }); // rust isn't covered
  assert.equal(calls.length, 0);
  await fetchTails(client, dumps, old, { only: ["Python"], now: () => NOW }); // lifetime counts need it
  assert.equal(calls.length, 2);
});

test("a later scan in the tab fetches only what's new, from an hour before the last one ended", async () => {
  const tails = new TailStore();
  const recent = { comments: [{ id: "c5", author: "alice", created_utc: COMMENTS_THROUGH + 10, link_id: "t3_p9" }] };
  const first = makeClient((u) => tailRows(u, recent));
  await fetchTails(first.client, await openFixtures({ tails }), POST, { now: () => NOW });

  // The next queued post is newer than where that tail got to.
  const next = { ...POST, id: "def456", createdUtc: NOW + 300 };
  recent.comments.push({ id: "c7", author: "alice", created_utc: NOW + 30, link_id: "t3_p9" });
  const second = makeClient((u) => tailRows(u, recent));
  const dumps = await openFixtures({ tails });
  await fetchTails(second.client, dumps, next, { now: () => NOW + 600 });
  assert.equal(second.calls.find((u) => kindOf(u) === "comments").searchParams.get("after"), String(NOW - INGEST_LAG));
  assert.deepEqual(await dumps.timestamps("comments", "Python", "alice"), [...ALICE_FILE_COMMENTS, COMMENTS_THROUGH + 10, NOW + 30]);
  assert.equal(dumps.covers("python").commentsThrough, NOW + 600);
});

test("a later scan of a post the tab's tail already covers fetches nothing for it", async () => {
  const tails = new TailStore();
  const first = makeClient((u) => tailRows(u, {}));
  await fetchTails(first.client, await openFixtures({ tails }), POST, { now: () => NOW });
  const second = makeClient((u) => tailRows(u, {}));
  const dumps = await openFixtures({ tails });
  await fetchTails(second.client, dumps, POST, { now: () => NOW + 600 });
  assert.equal(second.calls.length, 0);
  assert.equal(dumps.covers("python").commentsThrough, NOW); // before facts need nothing past it
});

test("a new build drops the tab's tail for that subreddit", async () => {
  const tails = new TailStore();
  const recent = { comments: [{ id: "c5", author: "alice", created_utc: COMMENTS_THROUGH + 10, link_id: "t3_p9" }] };
  const first = makeClient((u) => tailRows(u, recent));
  await fetchTails(first.client, await openFixtures({ tails }), POST, { now: () => NOW });

  const sub = MANIFEST.subreddits.python;
  const rebuilt = { format: DUMP_FORMAT, subreddits: { python: { ...sub, comments_to_utc: sub.comments_to_utc + 50 } } };
  const second = makeClient((u) => tailRows(u, {}));
  const dumps = await openFixtures({ manifest: rebuilt, tails });
  await fetchTails(second.client, dumps, POST, { now: () => NOW + 600 });
  assert.equal(second.calls.find((u) => kindOf(u) === "comments").searchParams.get("after"), String(COMMENTS_THROUGH + 50));
  assert.deepEqual(await dumps.timestamps("comments", "Python", "alice"), ALICE_FILE_COMMENTS);
});

// Lifetime aggregates (all in r/Python) and per-author searches, alongside the tail.
function api({ recent = {}, lifetime = { posts: 0, comments: 0 }, userTimes = {} }) {
  return (u) => {
    if (isTail(u)) return tailRows(u, recent);
    const kind = kindOf(u);
    if (u.pathname.endsWith("/aggregate") && !u.searchParams.has("subreddit")) {
      return json({ data: lifetime[kind] ? [{ key: "Python", count: String(lifetime[kind]) }] : [] });
    }
    const after = Number(u.searchParams.get("after") ?? -Infinity);
    const before = Number(u.searchParams.get("before") ?? Infinity);
    const times = (userTimes[kind] ?? []).filter((t) => t > after && t < before);
    if (u.pathname.endsWith("/aggregate")) return json({ data: [{ key: "Python", count: String(times.length) }] });
    return json({ data: times.sort((a, b) => b - a).slice(0, 100).map((t) => ({ created_utc: t })) });
  };
}

test("with a current tail, a scan limited to covered subreddits needs no requests per user", async () => {
  const recent = {
    comments: [
      { id: "c5", author: "Alice", created_utc: COMMENTS_THROUGH + 10, link_id: "t3_p9" },
      { id: "c8", author: "alice", created_utc: POST.createdUtc + 50, link_id: "t3_abc123" }, // in the thread
    ],
  };
  const { client, calls } = makeClient(api({ recent }));
  const dumps = await openFixtures();
  await fetchTails(client, dumps, POST, { only: ["Python"], now: () => NOW });
  const before = calls.length;
  const p = await buildProfile(client, "alice", 1, POST, { only: ["Python"], dumps });
  assert.equal(calls.length, before, "no per-user requests");
  assert.deepEqual([...p.subreddits], [["Python", { posts: 1, comments: 5 }]]);
  assert.deepEqual([p.targetPostsBefore, p.targetCommentsBefore], [1, 4]);
  assert.equal(p.targetTimelineComplete, true);
});

test("with a current tail, a full scan asks only for lifetime totals, with no before searches", async () => {
  const recent = { comments: [{ id: "c5", author: "alice", created_utc: COMMENTS_THROUGH + 10, link_id: "t3_p9" }] };
  const { client, calls } = makeClient(api({ recent, lifetime: { posts: 2, comments: 6 } }));
  const dumps = await openFixtures();
  await fetchTails(client, dumps, POST, { now: () => NOW });
  const before = calls.length;
  const p = await buildProfile(client, "alice", 1, POST, { dumps });
  const perUser = calls.slice(before);
  assert.equal(perUser.length, 2);
  assert.ok(perUser.every((u) => u.pathname.endsWith("/aggregate") && !u.searchParams.has("subreddit")));
  assert.deepEqual([p.targetPostsBefore, p.targetCommentsBefore], [1, 4]);
});

test("after a partial tail, a user's gap search starts where the tail stopped", async () => {
  const rows = minutely(150, COMMENTS_THROUGH + 60);
  const late = POST.createdUtc - 500;
  const { client, calls } = makeClient(api({ recent: { comments: rows }, lifetime: { comments: 9 }, userTimes: { comments: [late] } }));
  const dumps = await openFixtures();
  await fetchTails(client, dumps, POST, { now: () => NOW, budget: 1 });
  const through = dumps.covers("python").commentsThrough;
  assert.equal(through, rows[99].created_utc - 1);
  const p = await buildProfile(client, "alice", 1, POST, { dumps });
  const gap = calls.find((u) => u.pathname === "/api/comments/search" && u.searchParams.has("author"));
  assert.equal(gap.searchParams.get("after"), String(through));
  assert.equal(p.targetCommentsBefore, ALICE_FILE_COMMENTS.length + 1);
});
