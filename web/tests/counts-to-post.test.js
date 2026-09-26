// Every count a scan shows stops at the post (docs/adr/0006): per-subreddit counts and the
// "before" facts alike, from the archive where it has them. Only the thread's own comments,
// which come after the post by definition, are asked about past it, and only for the part
// the archive doesn't have.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ArcticShiftClient, INGEST_LAG, buildProfile, collectCommenters, estimateScan, fetchTails, importScan } from "../core.js";
import { MemoryBackend, ProfileCache } from "../cache.js";
import { DumpSource } from "../dumps.js";

const FIX = new URL("./fixtures/dumps/", import.meta.url);
const BASE = "https://dumps.test";
const MANIFEST = JSON.parse(readFileSync(new URL("manifest.json", FIX), "utf8"));
function localBuffer(relPath) {
  const buf = readFileSync(new URL(relPath, FIX));
  return { byteLength: buf.byteLength, slice: (s, e = buf.byteLength) => buf.buffer.slice(buf.byteOffset + s, buf.byteOffset + e) };
}
const openFixtures = () =>
  DumpSource.open({ baseUrl: BASE, fetchFn: async () => new Response(JSON.stringify(MANIFEST)), openFile: async (url) => localBuffer(url.slice(BASE.length + 1)) });

// The fixture r/Python files: posts trusted to POSTS_THROUGH, comments to COMMENTS_THROUGH.
// Alice: comments at 1698000000, 1699000000, 1699500000 and a post at 1699900000; post p1's
// thread has Alice's comment at 1699000000 and carol's at 1699990000 (after the cutoff).
const POSTS_THROUGH = 1699950000 - INGEST_LAG;
const COMMENTS_THROUGH = 1699990000 - INGEST_LAG;
const NOW = 1_700_100_000;
const NEW_POST = { id: "abc123", author: "op_user", subreddit: "Python", createdUtc: 1_700_000_000, title: "t", numComments: 40 };
// Older than both files' cutoffs: everything before it is in the archive.
const OLD_POST = { id: "p1", author: "Alice", subreddit: "Python", createdUtc: 1699800000, title: "p1", numComments: 2 };

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
const W = 1_000_000;

// Everyone's activity in r/Python (`rows[kind]`: {id, author, created_utc, link_id}), served
// the way Arctic Shift would: subreddit-wide and thread searches honour after/before, sort
// and limit; aggregates and interactions count alice's rows in the window.
function arctic(rows) {
  const within = (u, t) => {
    const after = u.searchParams.get("after");
    const before = u.searchParams.get("before");
    return (after === null || t > Number(after)) && (before === null || t < Number(before));
  };
  return (u) => {
    if (u.pathname === "/api/comments/tree") {
      const link = `t3_${u.searchParams.get("link_id")}`;
      const nodes = (rows.comments ?? []).filter((r) => r.link_id === link)
        .map((r) => ({ kind: "t1", data: { id: r.id, author: r.author, created_utc: r.created_utc, replies: "" } }));
      return json({ data: nodes });
    }
    if (u.pathname === "/api/users/interactions/subreddits") {
      const n = (k) => (rows[k] ?? []).filter((r) => r.author.toLowerCase() === "alice" && within(u, r.created_utc)).length;
      return json({ data: [{ subreddit: "Python", count: n("posts") * W + n("comments") }] });
    }
    const kind = kindOf(u);
    let mine = (rows[kind] ?? []).filter((r) => within(u, r.created_utc));
    if (u.searchParams.has("link_id")) mine = mine.filter((r) => r.link_id === `t3_${u.searchParams.get("link_id")}`);
    if (u.searchParams.has("author")) mine = mine.filter((r) => r.author.toLowerCase() === u.searchParams.get("author").toLowerCase());
    if (u.pathname.endsWith("/aggregate")) return json({ data: mine.length ? [{ key: "Python", count: mine.length }] : [] });
    mine.sort((a, b) => (u.searchParams.get("sort") === "asc" ? a.created_utc - b.created_utc : b.created_utc - a.created_utc));
    return json({ data: mine.slice(0, Number(u.searchParams.get("limit")) || 100) });
  };
}

// Alice's activity in r/Python: what the fixture files hold, plus a comment after them and
// one in NEW_POST's thread.
const ALICE = {
  posts: [{ id: "p1", author: "Alice", created_utc: 1699900000 }],
  comments: [
    { id: "c2", author: "alice", created_utc: 1698000000, link_id: "t3_p0" },
    { id: "c3", author: "Alice", created_utc: 1699000000, link_id: "t3_p1" },
    { id: "c1", author: "Alice", created_utc: 1699500000, link_id: "t3_p0" },
    { id: "c5", author: "alice", created_utc: COMMENTS_THROUGH + 100, link_id: "t3_p9" },
    { id: "c6", author: "alice", created_utc: NEW_POST.createdUtc + 60, link_id: "t3_abc123" },
  ],
};

test("a full scan's per-subreddit counts end at the post", async () => {
  const { client, calls } = makeClient(arctic(ALICE));
  const p = await buildProfile(client, "alice", 1, NEW_POST);
  const lifetime = calls.filter((u) => u.pathname.endsWith("/aggregate") && !u.searchParams.has("subreddit"));
  assert.equal(lifetime.length, 2);
  assert.ok(lifetime.every((u) => u.searchParams.get("before") === String(NEW_POST.createdUtc)));
  assert.deepEqual([...p.subreddits], [["Python", { posts: 1, comments: 4 }]]); // not the comment in the thread
});

test("the interactions fallback ends at the post too", async () => {
  const { client, calls } = makeClient((u) => {
    if (u.pathname.endsWith("/aggregate") && !u.searchParams.has("subreddit")) return json({ error: "Query timed out" }, 422);
    return arctic(ALICE)(u);
  });
  await buildProfile(client, "alice", 1, NEW_POST);
  const interactions = calls.find((u) => u.pathname === "/api/users/interactions/subreddits");
  assert.equal(interactions.searchParams.get("before"), String(NEW_POST.createdUtc));
});

test("an only scan of a post older than the files needs no requests per user", async () => {
  const { client, calls } = makeClient(arctic(ALICE));
  const dumps = await openFixtures();
  await fetchTails(client, dumps, OLD_POST, { only: ["Python"], now: () => NOW });
  const p = await buildProfile(client, "alice", 1, OLD_POST, { only: ["Python"], dumps });
  assert.equal(calls.length, 0);
  // Before OLD_POST (1699800000): the comments at 1698000000, 1699000000 and 1699500000.
  assert.deepEqual([...p.subreddits], [["Python", { posts: 0, comments: 3 }]]);
  assert.deepEqual([p.targetPostsBefore, p.targetCommentsBefore], [0, 3]);
});

test("an only scan of a newer post without a tail asks interactions only for between the files and the post", async () => {
  const { client, calls } = makeClient(arctic(ALICE));
  const dumps = await openFixtures();
  const p = await buildProfile(client, "alice", 1, NEW_POST, { only: ["Python"], dumps });
  const interactions = calls.filter((u) => u.pathname === "/api/users/interactions/subreddits");
  assert.equal(interactions.length, 1);
  assert.equal(interactions[0].searchParams.get("after"), String(POSTS_THROUGH));
  assert.equal(interactions[0].searchParams.get("before"), String(NEW_POST.createdUtc));
  assert.deepEqual([...p.subreddits], [["Python", { posts: 1, comments: 4 }]]);
});

test("a recent-activity fetch stops at the post, and then an only scan needs nothing per user", async () => {
  const everyone = {
    posts: [],
    comments: [...ALICE.comments.filter((r) => r.created_utc > COMMENTS_THROUGH), { id: "d1", author: "dave", created_utc: NEW_POST.createdUtc + 5, link_id: "t3_abc123" }],
  };
  const { client, calls } = makeClient(arctic(everyone));
  const dumps = await openFixtures();
  const report = await fetchTails(client, dumps, NEW_POST, { only: ["Python"], now: () => NOW });
  assert.ok(calls.every((u) => u.searchParams.get("before") === String(NEW_POST.createdUtc)));
  assert.deepEqual(report.map((r) => [r.kind, r.reachedEnd, r.through]), [
    ["posts", true, NEW_POST.createdUtc - 1],
    ["comments", true, NEW_POST.createdUtc - 1],
  ]);
  assert.deepEqual(await dumps.timestamps("comments", "Python", "dave"), []); // after the post: not fetched
  const sent = calls.length;
  const p = await buildProfile(client, "alice", 1, NEW_POST, { only: ["Python"], dumps });
  assert.equal(calls.length, sent);
  assert.deepEqual([...p.subreddits], [["Python", { posts: 1, comments: 4 }]]);
});

test("no recent-activity fetch for a post older than the files, even in an only scan", async () => {
  const { client, calls } = makeClient(arctic(ALICE));
  const report = await fetchTails(client, await openFixtures(), OLD_POST, { only: ["Python"], now: () => NOW });
  assert.deepEqual(report, []);
  assert.equal(calls.length, 0);
});

test("with no activity in the subreddit before the post, no before lookups", async () => {
  const { client, calls } = makeClient(arctic({ comments: [{ id: "x", author: "alice", created_utc: NEW_POST.createdUtc + 60, link_id: "t3_abc123" }] }));
  const p = await buildProfile(client, "alice", 1, NEW_POST);
  assert.equal(calls.filter((u) => u.searchParams.has("subreddit")).length, 0);
  assert.deepEqual([p.targetPostsBefore, p.targetCommentsBefore], [0, 0]);
});

test("the OP's counts before their own post don't include it", async () => {
  const { client } = makeClient(arctic({ posts: [{ id: "abc123", author: "op_user", created_utc: NEW_POST.createdUtc }] }));
  const p = await buildProfile(client, "op_user", 0, NEW_POST);
  assert.equal(p.subreddits.size, 0);
  assert.equal(p.targetPostsBefore, 0);
});

test("saved counts are per post: the same post reuses them, another post doesn't", async () => {
  const cache = new ProfileCache({ backend: new MemoryBackend(), ttlDays: 7, now: () => NOW });
  const first = makeClient(arctic(ALICE));
  await buildProfile(first.client, "alice", 1, NEW_POST, { cache });
  const again = makeClient(arctic(ALICE));
  const p = await buildProfile(again.client, "alice", 1, NEW_POST, { cache });
  assert.equal(again.calls.length, 0);
  assert.equal(p.cached, true);
  const other = makeClient(arctic(ALICE));
  await buildProfile(other.client, "alice", 1, { ...NEW_POST, id: "zzz999", createdUtc: NEW_POST.createdUtc + 3600 }, { cache });
  assert.ok(other.calls.some((u) => u.pathname.endsWith("/aggregate") && !u.searchParams.has("subreddit")));
});

test("estimateScan counts users saved for this post", async () => {
  const cache = new ProfileCache({ backend: new MemoryBackend(), ttlDays: 7, now: () => NOW });
  await buildProfile(makeClient(arctic(ALICE)).client, "alice", 1, NEW_POST, { cache });
  assert.equal((await estimateScan(cache, ["alice", "bob"], { before: NEW_POST.createdUtc })).saved, 1);
  assert.equal((await estimateScan(cache, ["alice", "bob"], { before: NEW_POST.createdUtc + 1 })).saved, 0);
});

test("a thread older than the files comes from comments_by_link plus one request for the comments after them", async () => {
  const thread = [
    { id: "c4", author: "carol", created_utc: 1699990000, link_id: "t3_p1" }, // in the files' last hour
    { id: "c9", author: "dave", created_utc: NOW - 100, link_id: "t3_p1" },
  ];
  const { client, calls } = makeClient(arctic({ comments: thread }));
  const commenters = await collectCommenters(client, OLD_POST, { dumps: await openFixtures() });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, "/api/comments/search");
  assert.equal(calls[0].searchParams.get("link_id"), "p1");
  assert.equal(calls[0].searchParams.get("after"), String(COMMENTS_THROUGH));
  assert.deepEqual(Object.fromEntries(commenters), {
    Alice: { count: 1 },
    carol: { count: 1 },
    dave: { count: 1 },
  });
});

test("a thread newer than the files comes from the comment tree", async () => {
  const { client, calls } = makeClient(arctic(ALICE));
  const commenters = await collectCommenters(client, NEW_POST, { dumps: await openFixtures() });
  assert.deepEqual(calls.map((u) => u.pathname), ["/api/comments/tree"]);
  assert.deepEqual(Object.fromEntries(commenters), { alice: { count: 1 } });
});

test("saved scans record that their counts stop at the post; older files don't claim it", () => {
  const rec = (summary) => ({
    summary: { id: "p1", post: { id: "p1", author: "Alice", subreddit: "Python", createdUtc: 1699800000 }, scannedAt: NOW, ...summary },
    profiles: [],
  });
  assert.equal(importScan(rec({ countsTo: "post" })).summary.countsTo, "post");
  assert.equal(importScan(rec({})).summary.countsTo, null);
  assert.equal(importScan(rec({ countsTo: "now" })).summary.countsTo, null);
});

test("the links from a user's counts to Arctic Shift stop at the post too", async () => {
  const { arcticSearchUrl } = await import("../core.js");
  const u = new URL(arcticSearchUrl("comments", "alice", "Python", 1_600_000_000, NEW_POST.createdUtc));
  assert.equal(u.searchParams.get("after"), "1600000000");
  assert.equal(u.searchParams.get("before"), String(NEW_POST.createdUtc));
  assert.equal(new URL(arcticSearchUrl("posts", "alice", "rust")).searchParams.get("before"), null);
});

test("the end-of-scan note can tell whether Arctic Shift filled a gap between the files and the post", async () => {
  const { client } = makeClient(arctic(ALICE));
  const dumps = await openFixtures();
  await buildProfile(client, "alice", 1, OLD_POST, { only: ["Python"], dumps });
  assert.equal(dumps.lifetimeGaps ?? 0, 0);
  await buildProfile(client, "alice", 1, NEW_POST, { only: ["Python"], dumps });
  assert.equal(dumps.lifetimeGaps, 1);
});

test("the breakdown labels totals that end at the post as totals, and only real split parts as split", async () => {
  // Totals now carry before=<post time>, so parameters alone can't tell them from a split.
  const full = makeClient(arctic(ALICE));
  await buildProfile(full.client, "alice", 1, NEW_POST);
  assert.equal(full.client.byLabel.get("lifetime posts"), 1);
  assert.equal(full.client.byLabel.get("lifetime comments"), 1);
  assert.equal(full.client.byLabel.get("before comments"), 1);
  assert.ok(![...full.client.byLabel.keys()].some((l) => l.includes("split")), [...full.client.byLabel.keys()].join(", "));

  // Timed out, with only: the per-subreddit parts are the split, not "before" counts.
  const split = makeClient((u) => {
    if (u.pathname.endsWith("/aggregate") && !u.searchParams.has("subreddit")) return json({ error: "Query timed out" }, 422);
    if (u.pathname === "/api/users/interactions/subreddits") return json({ error: "not supported" }, 400);
    return arctic(ALICE)(u);
  });
  await buildProfile(split.client, "alice", 1, NEW_POST, { only: ["rust"] });
  assert.equal(split.client.byLabel.get("lifetime comments, split"), 2); // Python and rust
  assert.equal(split.client.byLabel.get("before comments, count") ?? 0, 0);
});
