// The scan's request breakdown: every Arctic Shift request counted by what it was for, the
// retries and why, how far each recent-activity fetch got, and the archive requests by
// file, so a scan's cost can be checked against what the code should have asked.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ArcticShiftClient, INGEST_LAG, buildProfile, fetchTails, requestLabel } from "../core.js";
import { DumpSource } from "../dumps.js";
import { breakdownLines } from "../format.js";

const FIX = new URL("./fixtures/dumps/", import.meta.url);
const BASE = "https://dumps.test";
const MANIFEST = JSON.parse(readFileSync(new URL("manifest.json", FIX), "utf8"));
function localBuffer(relPath) {
  const buf = readFileSync(new URL(relPath, FIX));
  return { byteLength: buf.byteLength, slice: (s, e = buf.byteLength) => buf.buffer.slice(buf.byteOffset + s, buf.byteOffset + e) };
}
const localFile = async (url) => localBuffer(url.slice(BASE.length + 1));

const COMMENTS_THROUGH = 1699990000 - INGEST_LAG;
const NOW = 1_700_100_000;
const POST = { id: "abc123", author: "op_user", subreddit: "Python", createdUtc: 1_700_000_000, title: "t", numComments: 40 };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeClient(handler) {
  const clock = { t: NOW };
  return new ArcticShiftClient({
    delay: 0,
    fetchFn: async (url) => handler(new URL(url)),
    sleep: async (s) => { clock.t += s; },
    now: () => clock.t,
    random: () => 0.5,
  });
}

test("requestLabel names what each request shape is for", () => {
  const cases = [
    ["/api/posts/ids", { ids: "abc" }, "post"],
    ["/api/comments/search", { subreddit: "Python", after: 1, sort: "asc" }, "recent comments"],
    ["/api/posts/search", { subreddit: "Python", after: 1, sort: "asc" }, "recent posts"],
    ["/api/comments/tree", { link_id: "abc" }, "thread tree"],
    ["/api/comments/search", { link_id: "abc", sort: "asc" }, "thread pages"],
    ["/api/posts/search/aggregate", { aggregate: "subreddit", author: "a", limit: "" }, "lifetime posts"],
    ["/api/comments/search/aggregate", { aggregate: "subreddit", author: "a", limit: "", after: 5 }, "lifetime comments"],
    // Every count carries `before` (docs/adr/0006), so the client says which are split parts.
    ["/api/comments/search/aggregate", { aggregate: "subreddit", author: "a", after: 5, before: 9 }, "lifetime comments, split", { split: true }],
    ["/api/comments/search/aggregate", { aggregate: "subreddit", author: "a", subreddit: "rust", before: 9 }, "lifetime comments, split", { split: true }],
    ["/api/comments/search/aggregate", { aggregate: "subreddit", author: "a", before: 9 }, "lifetime comments"],
    ["/api/users/interactions/subreddits", { author: "a" }, "interactions"],
    ["/api/comments/search", { author: "a", subreddit: "Python", before: 9, fields: "created_utc" }, "before comments"],
    ["/api/posts/search/aggregate", { aggregate: "subreddit", author: "a", subreddit: "Python", before: 9 }, "before posts, count"],
    ["/api/somewhere/else", {}, "/api/somewhere/else"],
  ];
  for (const [path, params, label, opts] of cases) assert.equal(requestLabel(path, params, opts), label, `${path} ${JSON.stringify(params)}`);
});

test("the client counts every request it sends by label, retries included, and the retries by reason", async () => {
  let n = 0;
  const client = makeClient((u) => {
    n++;
    if (u.pathname === "/api/posts/ids" && n === 1) return json({ error: "Timeout. Maybe slow down a bit" }, 422);
    if (u.pathname === "/api/posts/ids") return json({ data: [{ id: "abc123", author: "op", subreddit: "Python", created_utc: 5 }] });
    return json({ data: [] });
  });
  await client.getPost("abc123");
  await client.subredditCounts("posts", "alice");
  assert.equal(client.requests, 3);
  assert.deepEqual(Object.fromEntries(client.byLabel), { post: 2, "lifetime posts": 1 });
  assert.deepEqual(Object.fromEntries(client.retries), { "server busy": 1 });
});

test("fetchTails reports each kind's pages, budget, whether it reached the post and how far it got", async () => {
  const rows = Array.from({ length: 150 }, (_, i) => ({ id: `m${i}`, author: "dave", created_utc: COMMENTS_THROUGH + 60 * (i + 1), link_id: "t3_x" }));
  const client = makeClient((u) => {
    const after = Number(u.searchParams.get("after"));
    const mine = u.pathname.includes("/comments/") ? rows : [];
    return json({ data: mine.filter((r) => r.created_utc > after).slice(0, 100) });
  });
  const dumps = await DumpSource.open({ baseUrl: BASE, fetchFn: async () => new Response(JSON.stringify(MANIFEST)), openFile: localFile });
  const report = await fetchTails(client, dumps, POST, { now: () => NOW, budget: 1 });
  assert.deepEqual(report, [
    { subreddit: "Python", kind: "posts", pages: 1, budget: 1, reachedEnd: true, through: POST.createdUtc - 1, error: null }, // counts stop at the post
    { subreddit: "Python", kind: "comments", pages: 1, budget: 1, reachedEnd: false, through: rows[99].created_utc - 1, error: null },
  ]);
  assert.deepEqual(await fetchTails(client, dumps, { ...POST, createdUtc: 1_600_000_000 }, { now: () => NOW }), []);
});

test("the archive's onRequest is told which URL each request is for", async () => {
  const urls = [];
  const fetchFn = async (url, init = {}) => {
    const path = url.slice(BASE.length + 1);
    if (path === "manifest.json") return new Response(JSON.stringify(MANIFEST));
    const [, start, end] = /bytes=(\d+)-(\d*)/.exec(new Headers(init.headers).get("range"));
    const buf = readFileSync(new URL(path, FIX));
    return new Response(buf.subarray(Number(start), end ? Number(end) + 1 : buf.byteLength), { status: 206 });
  };
  const dumps = await DumpSource.open({ baseUrl: BASE, fetchFn, onRequest: (url) => urls.push(String(url)) });
  // Lifetime activity in r/Python, so the "before" facts are looked up in the files.
  const api = makeClient((u) => json({ data: u.pathname.endsWith("/aggregate") ? [{ key: "Python", count: 3 }] : [] }));
  await buildProfile(api, "alice", 0, { ...POST, createdUtc: 1_699_000_500 }, { dumps });
  assert.equal(urls[0], `${BASE}/manifest.json`);
  assert.ok(urls.slice(1).length > 0 && urls.slice(1).every((u) => u.endsWith("_by_author.parquet")), urls.join(" "));
});

test("breakdownLines lists requests by purpose, adding up to the total, then retries, tails and the archive", () => {
  const byLabel = new Map([["interactions", 53], ["post", 1], ["recent comments", 2], ["recent posts", 2], ["thread tree", 1]]);
  const lines = breakdownLines({
    requests: 59,
    byLabel,
    retries: new Map([["server busy", 2]]),
    tails: [
      { subreddit: "Hasan_Piker", kind: "posts", pages: 2, budget: 2, reachedEnd: false, through: 1790290000, error: null },
      { subreddit: "Hasan_Piker", kind: "comments", pages: 2, budget: 2, reachedEnd: false, through: 1790280000, error: null },
    ],
    archive: 123,
    archiveByFile: new Map([["manifest", 1], ["comments_by_author", 60], ["posts_by_author", 62]]),
  });
  assert.deepEqual(lines, [
    "Arctic Shift: 59 requests",
    "Post: 1",
    "Recent activity, posts (whole subreddit): 2",
    "Recent activity, comments (whole subreddit): 2",
    "Thread, comment tree: 1",
    "Lifetime totals per user, interactions: 53",
    "Retries: server busy 2 (included above)",
    "r/Hasan_Piker posts since the archive files: 2 of 2 pages, stopped at the budget; complete up to 2026-09-24 22:46 UTC",
    "r/Hasan_Piker comments since the archive files: 2 of 2 pages, stopped at the budget; complete up to 2026-09-24 20:00 UTC",
    "Archive: 123 requests (comments_by_author 60, manifest 1, posts_by_author 62)",
  ]);
  const counted = lines.slice(1).map((l) => /^[^:]+: (\d+)$/.exec(l)?.[1]).filter(Boolean).map(Number);
  assert.equal(counted.reduce((a, b) => a + b, 0), 59);
});

test("breakdownLines says when there was no recent-activity fetch, and how a tail ended", () => {
  const lines = breakdownLines({ requests: 0, byLabel: new Map(), retries: new Map(), tails: [], archive: null, archiveByFile: new Map() });
  assert.deepEqual(lines, ["Arctic Shift: 0 requests", "No recent activity was fetched for the whole subreddit."]);
  const ended = breakdownLines({
    requests: 2, byLabel: new Map([["recent comments", 1], ["recent posts", 1]]), retries: new Map(), archive: null, archiveByFile: new Map(),
    tails: [
      { subreddit: "Python", kind: "posts", pages: 1, budget: 2, reachedEnd: true, through: 1700100000, error: null },
      { subreddit: "Python", kind: "comments", pages: 0, budget: 2, reachedEnd: false, through: 1699986400, error: "Query timed out" },
    ],
  });
  assert.ok(ended.includes("r/Python posts since the archive files: 1 of 2 pages, reached the post")); // counts stop at the post
  assert.ok(ended.includes("r/Python comments since the archive files: 0 of 2 pages, stopped: Query timed out; complete up to 2023-11-14 18:26 UTC"));
});

test("archiveFileName names the file an archive request is for", async () => {
  const { archiveFileName } = await import("../dumps.js");
  assert.equal(archiveFileName("https://rpp-db.tinted979.dev/manifest.json"), "manifest");
  assert.equal(archiveFileName("https://rpp-db.tinted979.dev/r/python/2026-09-24/comments_by_link.parquet"), "comments_by_link");
  assert.equal(archiveFileName(new URL("https://x.test/r/a/v1/posts_by_author.parquet")), "posts_by_author");
});
