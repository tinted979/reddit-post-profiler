import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Aborted,
  ArcticShiftClient,
  ArcticShiftError,
  Eta,
  QueryTimeout,
  ServerBusy,
  Unsupported,
  buildProfile,
  DEFAULT_BADGES,
  activityTier,
  badgeFacts,
  formatBadges,
  parseBadges,
  sameBadges,
  tierCounts,
  arcticSearchUrl,
  collectCommenters,
  deserializeProfile,
  estimateScan,
  exportScans,
  importScan,
  parseScanExport,
  LARGE_SCAN,
  mapPool,
  parsePostRef,
  parseSubreddits,
  scanStats,
  serializeProfile,
  sortedSubreddits,
  toCsv,
  yearlyRanges,
} from "../core.js";
import { MemoryBackend, ProfileCache, ScanStore } from "../cache.js";

const POST = { id: "abc123", author: "op_user", subreddit: "Python", createdUtc: 1_700_000_000, title: "t" };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// A client whose fetch is served by `handler(url) -> Response`; records calls and sleeps.
// Time is simulated: `sleep` advances the clock instantly.
function makeClient(handler, { delay = 0 } = {}) {
  const calls = [];
  const starts = [];
  const sleeps = [];
  const clock = { t: 1_000 };
  const client = new ArcticShiftClient({
    delay,
    fetchFn: async (url) => {
      const u = new URL(url);
      calls.push(u);
      starts.push(clock.t);
      return handler(u, calls.length);
    },
    sleep: async (s) => {
      sleeps.push(s);
      clock.t += s;
    },
    now: () => clock.t,
  });
  return { client, calls, starts, sleeps, clock };
}

function sequence(...responses) {
  return (_u, n) => responses[Math.min(n, responses.length) - 1]();
}

const W = 1_000_000; // POST_WEIGHT: an interactions count of p * W + c is p posts, c comments
const isInteractions = (u) => u.pathname === "/api/users/interactions/subreddits";
const interactions = (rows) => json({ data: rows.map(([subreddit, posts, comments]) => ({ subreddit, count: posts * W + comments })) });
const notSupported = () => json({ data: null, error: "This user is currently not supported (too much data)" }, 400);

// Timestamps for "before" searches: n items, one a day, the newest a day before `end`.
const daily = (n, end = POST.createdUtc) => Array.from({ length: n }, (_, i) => end - (i + 1) * 86400);

// Answers a timestamp search (fields=created_utc) from `times`, honouring sort and limit.
function searchTimes(u, times) {
  const sorted = [...times].sort((a, b) => (u.searchParams.get("sort") === "asc" ? a - b : b - a));
  return json({ data: sorted.slice(0, Number(u.searchParams.get("limit"))).map((t) => ({ created_utc: t })) });
}

// Aggregate responses: lifetime `posts`/`comments` rows, and "before" answers for
// subreddit-filtered queries: `before[kind]` items, one a day (or `beforeTimes[kind]`),
// from the timestamp search, and their count from the aggregate. Fails the test if the
// interactions endpoint is queried.
function aggregates({ posts = [], comments = [], before = { posts: 0, comments: 0 }, beforeTimes = {} }) {
  return (u) => {
    assert.ok(!isInteractions(u), "unexpected interactions query");
    const kind = u.pathname.includes("/posts/") ? "posts" : "comments";
    const times = beforeTimes[kind] ?? daily(before[kind]);
    if (u.pathname === `/api/${kind}/search`) return searchTimes(u, times);
    if (u.searchParams.has("subreddit")) {
      return json({ data: [{ key: u.searchParams.get("subreddit"), count: String(times.length) }] });
    }
    return json({ data: (kind === "posts" ? posts : comments).map(([key, n]) => ({ key, count: String(n) })) });
  };
}

async function collect(iter) {
  const out = [];
  for await (const x of iter) out.push(x);
  return out;
}

test("parsePostRef accepts urls, fullnames and ids", () => {
  for (const ref of [
    "https://www.reddit.com/r/Python/comments/abc123/some_title/",
    "https://old.reddit.com/r/Python/comments/ABC123/t/def456/?context=3",
    "reddit.com/r/Python/comments/abc123",
    "https://redd.it/abc123",
    "t3_abc123",
    "  abc123 ",
  ]) {
    assert.equal(parsePostRef(ref), "abc123", ref);
  }
  for (const bad of ["", "https://www.reddit.com/r/Python/", "not a post!"]) {
    assert.throws(() => parsePostRef(bad));
  }
});

test("getPost", async () => {
  const { client } = makeClient(() =>
    json({ data: [{ id: "abc123", author: "op", subreddit: "Python", created_utc: 1700000000, title: "Hi" }] }),
  );
  assert.deepEqual(await client.getPost("abc123"), {
    id: "abc123", author: "op", subreddit: "Python", createdUtc: 1700000000, title: "Hi", numComments: 0,
  });
});

test("thread comments paginate and dedupe", async () => {
  const page1 = [0, 1, 2].map((i) => ({ id: `c${i}`, author: "a", created_utc: 100 + i }));
  const page2 = [{ id: "c2", author: "a", created_utc: 102 }, { id: "c3", author: "b", created_utc: 103 }];
  const { client, calls } = makeClient(sequence(() => json({ data: page1 }), () => json({ data: page2 })));
  const ids = (await collect(client.iterThreadComments("abc123", 3))).map((c) => c.id);
  assert.deepEqual(ids, ["c0", "c1", "c2", "c3"]);
  assert.equal(calls[0].searchParams.get("after"), null);
  assert.equal(calls[1].searchParams.get("after"), "101");
});

test("stuck page terminates", async () => {
  const page = [0, 1].map((i) => ({ id: `c${i}`, author: "a", created_utc: 500 }));
  const { client, calls } = makeClient(
    sequence(() => json({ data: page }), () => json({ data: page }), () => json({ data: page }), () => json({ data: [] })),
  );
  assert.equal((await collect(client.iterThreadComments("abc123", 2))).length, 2);
  // Two pages in a row with nothing new end the scan.
  assert.deepEqual(calls.map((u) => u.searchParams.get("after")), [null, "499", "501"]);
});

test("subredditCounts parses string counts and passes filters", async () => {
  const { client, calls } = makeClient(() => json({ data: [{ key: "Python", count: "12" }, { key: "rust", count: "3" }] }));
  const counts = await client.subredditCounts("comments", "alice", { subreddit: "Python", before: 123 });
  assert.deepEqual([...counts], [["Python", 12], ["rust", 3]]);
  const p = calls[0].searchParams;
  assert.equal(calls[0].pathname, "/api/comments/search/aggregate");
  assert.deepEqual([p.get("aggregate"), p.get("author"), p.get("limit"), p.get("subreddit"), p.get("before")],
    ["subreddit", "alice", "", "Python", "123"]);
});

test("429 waits and retries", async () => {
  const { client, sleeps } = makeClient(
    sequence(() => json({ error: "Too many requests" }, 429), () => json({ data: [{ key: "a", count: "1" }] })),
  );
  assert.deepEqual([...(await client.subredditCounts("posts", "alice"))], [["a", 1]]);
  assert.deepEqual(sleeps, [30]);
});

test("slow down is retried with backoff", async () => {
  const slow = () => json({ data: null, error: "Timeout. Maybe slow down a bit" }, 422);
  const { client, sleeps } = makeClient(sequence(slow, slow, () => json({ data: [{ key: "a", count: "1" }] })));
  assert.deepEqual([...(await client.subredditCounts("posts", "alice"))], [["a", 1]]);
  assert.deepEqual(sleeps, [2, 4]);
});

test("network errors retry, then fail", async () => {
  const { client, calls } = makeClient(() => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(client.subredditCounts("posts", "alice"), ArcticShiftError);
  assert.equal(calls.length, client.maxRetries + 1);
});

test("API error payload raises", async () => {
  const { client } = makeClient(() => json({ error: "Invalid id" }, 400));
  await assert.rejects(client.getPost("!!"), /Invalid id/);
});

test("query timeout falls back to yearly chunks", async () => {
  const { client, calls } = makeClient((u) =>
    u.searchParams.has("after")
      ? json({ data: [{ key: "Python", count: "2" }] })
      : json({ error: "Query timed out" }),
  );
  const counts = await client.subredditCounts("comments", "busy", { before: 1_104_537_610 });
  assert.deepEqual([...counts], [["Python", 2]]);
  assert.equal(calls.length, 3);
});

test("yearlyRanges", () => {
  const r = yearlyRanges(1_700_000_000, 0);
  assert.equal(r[0][0], 1_104_537_600);
  assert.equal(r.at(-1)[1], 1_700_000_000);
  assert.equal(r.length, 2023 - 2005 + 1);
});

test("collectCommenters counts and filters", async () => {
  const comments = ["alice", "alice", "bob", "[deleted]", "AutoModerator", "SpamBot"].map((author, i) => ({
    id: String(i), author, created_utc: i,
  }));
  const { client } = makeClient(() => json({ data: comments }));
  const commenters = await collectCommenters(client, POST, { exclude: ["u/spambot"], includeOp: true });
  assert.deepEqual(Object.fromEntries(commenters), {
    alice: { count: 2, last: 1 }, bob: { count: 1, last: 2 }, op_user: { count: 0, last: null },
  });
});

test("interactionCounts unpacks posts and comments", async () => {
  const { client, calls } = makeClient(() => json({ data: [{ subreddit: "laos", count: 4_000_017 }, { subreddit: "rust", count: 3 }] }));
  const counts = await client.interactionCounts("alice", { after: 5, before: 9 });
  assert.deepEqual([...counts], [["laos", { posts: 4, comments: 17 }], ["rust", { posts: 0, comments: 3 }]]);
  const p = calls[0].searchParams;
  assert.equal(calls[0].pathname, "/api/users/interactions/subreddits");
  assert.deepEqual([p.get("author"), p.get("limit"), p.get("weight_posts"), p.get("weight_comments"), p.get("after"), p.get("before")],
    ["alice", "", String(W), "1", "5", "9"]);
});

test("interactionCounts rejects refused users and undecodable counts", async () => {
  await assert.rejects(makeClient(notSupported).client.interactionCounts("AutoModerator"), Unsupported);
  for (const count of [-5, 1.5]) {
    const { client } = makeClient(() => json({ data: [{ subreddit: "x", count }] }));
    await assert.rejects(client.interactionCounts("bot"), Unsupported);
  }
});

test("buildProfile merges case-insensitively and fetches before counts", async () => {
  const { client, calls } = makeClient((u) => {
    if (u.searchParams.has("subreddit")) assert.equal(u.searchParams.get("before"), String(POST.createdUtc));
    return aggregates({
      posts: [["Python", 2], ["rust", 1]],
      comments: [["python", 10], ["AskReddit", 5]],
      before: { posts: 1, comments: 4 },
    })(u);
  });
  const p = await buildProfile(client, "alice", 3, POST);
  assert.equal(calls.length, 4);
  assert.equal(p.targetPostsBefore, 1);
  assert.equal(p.targetCommentsBefore, 4);
  assert.deepEqual(Object.fromEntries(p.subreddits), {
    Python: { posts: 2, comments: 10 }, rust: { posts: 1, comments: 0 }, AskReddit: { posts: 0, comments: 5 },
  });
});

test("buildProfile skips before queries the lifetime counts rule out", async () => {
  const { client, calls } = makeClient((u) => {
    assert.ok(!u.searchParams.has("before"), "unexpected before query");
    return aggregates({ posts: [["rust", 4]], comments: [["python", 2], ["rust", 9]] })(u);
  });
  const p = await buildProfile(client, "bob", 2, POST);
  assert.equal(calls.length, 2);
  assert.equal(p.targetPostsBefore, 0);
  assert.equal(p.targetCommentsBefore, 0);
  assert.deepEqual(Object.fromEntries(p.subreddits), {
    rust: { posts: 4, comments: 9 }, python: { posts: 0, comments: 2 },
  });
});

test("buildProfile skips the OP's posts-before query when their only post is this one", async () => {
  const { client, calls } = makeClient((u) => {
    if (u.searchParams.has("before")) assert.ok(u.pathname.includes("/comments/"));
    return aggregates({ posts: [["Python", 1]], comments: [["Python", 5]], before: { posts: 0, comments: 3 } })(u);
  });
  const p = await buildProfile(client, "OP_User", 2, POST);
  assert.equal(calls.length, 3);
  assert.equal(p.targetPostsBefore, 0);
  assert.equal(p.targetCommentsBefore, 3);
});

test("timed-out lifetime aggregates fall back to one interactions query", async () => {
  const { client, calls } = makeClient((u) => {
    if (isInteractions(u)) return interactions([["Python", 2, 40], ["rust", 0, 7]]);
    if (u.pathname.endsWith("/search")) return searchTimes(u, u.pathname.includes("/posts/") ? [] : daily(30));
    return u.pathname.includes("/posts/") ? json({ data: [{ key: "Python", count: "2" }] }) : json({ error: "Query timed out" });
  });
  const p = await buildProfile(client, "busy", 1, POST);
  assert.deepEqual(Object.fromEntries(p.subreddits), { Python: { posts: 2, comments: 40 }, rust: { posts: 0, comments: 7 } });
  assert.equal(p.targetCommentsBefore, 30);
  assert.equal(calls.filter(isInteractions).length, 1);
  assert.ok(!calls.some((u) => u.searchParams.has("after")), "should not split into years");
});

test("when interactions can't answer either, only the timed-out kind is split into years", async () => {
  const { client, calls, clock } = makeClient((u) => {
    if (isInteractions(u)) return notSupported();
    if (u.pathname.includes("/posts/")) return json({ data: [{ key: "rust", count: "1" }] });
    return u.searchParams.has("after") ? json({ data: [{ key: "rust", count: "1" }] }) : json({ error: "Query timed out" });
  });
  clock.t = Date.UTC(2024, 5, 1) / 1000;
  const p = await buildProfile(client, "busy", 1, POST);
  const years = yearlyRanges(null, client._now()).length;
  assert.equal(years, 2024 - 2005 + 1);
  assert.equal(calls.filter((u) => u.pathname.includes("/posts/")).length, 1);
  // The full comments query is sent twice, and not again once interactions has failed.
  assert.equal(calls.filter((u) => u.pathname.includes("/comments/") && !u.searchParams.has("after")).length, 2);
  assert.equal(p.subreddits.get("rust").comments, years);
  assert.equal(p.subreddits.get("rust").posts, 1);
});

test("concurrent requests are spaced by the delay", async () => {
  const { client, clock } = makeClient(() => json({ data: [] }), { delay: 0.5 });
  await Promise.all([1, 2, 3].map(() => client.subredditCounts("posts", "alice")));
  // Each caller reserves its own start slot (now, +0.5s, +1s), so the last one waits
  // until +1s rather than all of them firing together after a single delay.
  assert.equal(clock.t, 1001);
});

test("a rate limit pauses every request on the client", async () => {
  let n = 0;
  const { client, starts, sleeps } = makeClient(() =>
    ++n === 1 ? json({ error: "Too many requests" }, 429) : json({ data: [] }),
  );
  // One request in flight at a time, so b and c queue behind a.
  client.maxInFlight = client._limit = 1;
  await Promise.all(["a", "b", "c"].map((user) => client.subredditCounts("posts", user)));
  // a's 429 pauses its own retry and the requests queued behind it.
  assert.equal(starts[0], 1000);
  assert.equal(starts.length, 4);
  assert.ok(starts.slice(1).every((t) => t >= 1030), `starts: ${starts}`);
  assert.ok(sleeps.includes(30));
});

// A client whose responses resolve only when the test says so, to observe concurrency.
function makeGatedClient(maxInFlight) {
  const pending = [];
  let active = 0;
  let peak = 0;
  const clock = { t: 0 };
  const client = new ArcticShiftClient({
    delay: 0,
    maxInFlight,
    fetchFn: () => {
      active++;
      peak = Math.max(peak, active);
      return new Promise((resolve) => pending.push((r) => { active--; resolve(r); }));
    },
    sleep: async (s) => { clock.t += s; },
    now: () => clock.t,
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { client, pending, tick, peak: () => peak };
}

test("requests in flight never exceed the cap", async () => {
  const { client, pending, tick, peak } = makeGatedClient(2);
  const all = Promise.all([1, 2, 3, 4, 5].map(() => client.subredditCounts("posts", "a")));
  for (let i = 0; i < 5; i++) {
    await tick();
    pending.shift()(json({ data: [] }));
  }
  await all;
  assert.equal(peak(), 2);
});

test("slow down halves the cap, and successes raise it again", async () => {
  let slow = true;
  const { client } = makeClient(() =>
    slow ? json({ data: null, error: "Timeout. Maybe slow down a bit" }, 422) : json({ data: [] }),
  );
  client.maxInFlight = client._limit = 4;
  await assert.rejects(client._get("/api/posts/ids", {}), ServerBusy);
  assert.equal(client._limit, 1);
  slow = false;
  for (let i = 0; i < 30; i++) await client._get("/api/posts/ids", {});
  assert.equal(client._limit, 4);
});

test("mapPool limits concurrency and passes indexes", async () => {
  let active = 0;
  let peak = 0;
  const seen = [];
  await mapPool(["a", "b", "c", "d", "e"], 2, async (item, i) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    seen.push([item, i]);
    active--;
  });
  assert.equal(peak, 2);
  assert.deepEqual(seen.sort(), [["a", 0], ["b", 1], ["c", 2], ["d", 3], ["e", 4]]);
});

test("mapPool stops starting work once aborted", async () => {
  const controller = new AbortController();
  const started = [];
  await assert.rejects(
    mapPool([1, 2, 3, 4], 1, async (item) => {
      started.push(item);
      if (item === 2) controller.abort();
    }, controller.signal),
    Aborted,
  );
  assert.deepEqual(started, [1, 2]);
});

test("parseSubreddits strips prefixes and dedupes", () => {
  assert.deepEqual(parseSubreddits(["r/rust", "/r/Golang", " ", "Rust", "python"]), ["rust", "Golang", "python"]);
});

test("buildProfile with only keeps listed subreddits and adds empty ones", async () => {
  const { client, calls } = makeClient(aggregates({
    posts: [["rust", 4], ["funny", 1]],
    comments: [["python", 2], ["AskReddit", 9]],
  }));
  const p = await buildProfile(client, "bob", 2, POST, { only: ["r/Rust", "golang"] });
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.fromEntries(p.subreddits), {
    rust: { posts: 4, comments: 0 }, python: { posts: 0, comments: 2 }, golang: { posts: 0, comments: 0 },
  });
});

test("a timed-out aggregate falls back to one query per listed subreddit", async () => {
  const { client, calls } = makeClient((u) => {
    const sub = u.searchParams.get("subreddit");
    if (!sub) return json({ error: "Query timed out" });
    return json({ data: sub === "rust" ? [{ key: "rust", count: "3" }] : [] });
  });
  const counts = await client.subredditCounts("comments", "busy", { only: ["Python", "rust"] });
  assert.deepEqual([...counts], [["rust", 3]]);
  assert.equal(calls.length, 4); // 2 full attempts + 1 per listed subreddit
  assert.ok(!calls.some((u) => u.searchParams.has("after")), "should not split into years");
});

test("buildProfile passes the history window to every query", async () => {
  const after = POST.createdUtc - 1000;
  const { client, calls } = makeClient((u) => {
    assert.equal(u.searchParams.get("after"), String(after));
    return aggregates({ posts: [["Python", 9]], comments: [["Python", 9]], before: { posts: 9, comments: 9 } })(u);
  });
  const p = await buildProfile(client, "alice", 1, POST, { after });
  assert.equal(calls.length, 4);
  assert.equal(p.targetCommentsBefore, 9);
});

test("buildProfile skips before queries for a post older than the window", async () => {
  const { client, calls } = makeClient(aggregates({ posts: [["Python", 3]], comments: [["Python", 9]] }));
  const p = await buildProfile(client, "alice", 1, POST, { after: POST.createdUtc + 1 });
  assert.equal(calls.length, 2);
  assert.equal(p.targetPostsBefore + p.targetCommentsBefore, 0);
});

test("yearlyRanges starts at the window", () => {
  const after = Date.UTC(2020, 5, 1) / 1000;
  const ranges = yearlyRanges(Date.UTC(2022, 0, 1) / 1000, 0, after);
  assert.deepEqual(ranges, [[after, Date.UTC(2021, 0, 1) / 1000], [Date.UTC(2021, 0, 1) / 1000, Date.UTC(2022, 0, 1) / 1000]]);
});

const t1 = (id, author, replies = []) => ({
  kind: "t1",
  data: { id, author, created_utc: 1, replies: replies.length ? { kind: "Listing", data: { children: replies } } : "" },
});

test("collectCommenters reads the whole thread from one comment tree request", async () => {
  const tree = [
    t1("a", "alice", [t1("b", "bob", [t1("c", "alice")]), t1("d", "[deleted]")]),
    t1("e", "carol"),
    t1("a", "alice"), // duplicates are counted once
  ];
  const { client, calls } = makeClient(() => json({ data: tree }));
  const counts = await collectCommenters(client, POST);
  assert.deepEqual(Object.fromEntries([...counts].map(([name, c]) => [name, c.count])), { alice: 2, bob: 1, carol: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, "/api/comments/tree");
  assert.equal(calls[0].searchParams.get("link_id"), POST.id);
});

test("an incomplete or failed comment tree falls back to paging", async () => {
  const page = [{ id: "x", author: "dave", created_utc: 5 }];
  for (const treeResponse of [
    () => json({ data: [t1("a", "alice"), { kind: "more", data: { children: ["q"] } }] }),
    () => json({ data: [] }),
    () => json({ error: "Query timed out" }),
    () => json({ error: "Invalid parameter" }, 400),
    () => json({ data: [{ kind: "t1", data: { id: "a", author: "alice", replies: { kind: "Listing", data: {} } } }] }),
  ]) {
    let pages = 0;
    const { client, calls } = makeClient((u) =>
      u.pathname === "/api/comments/tree" ? treeResponse() : json({ data: pages++ ? [] : page }),
    );
    assert.deepEqual([...(await collectCommenters(client, POST))], [["dave", { count: 1, last: 5 }]]);
    assert.equal(calls[1].searchParams.get("limit"), "auto");
    assert.equal(calls.length, 3); // tree, one page, one empty page
  }
});

function makeCache(t = POST.createdUtc + 30 * 86400) {
  const clock = { t };
  return { cache: new ProfileCache({ backend: new MemoryBackend(), ttlDays: 7, now: () => clock.t }), clock };
}

test("a cached profile makes no requests", async () => {
  const handler = aggregates({ posts: [["Python", 3]], comments: [["Python", 9], ["rust", 4]], before: { posts: 1, comments: 2 } });
  const { cache } = makeCache();
  const first = makeClient(handler);
  const p1 = await buildProfile(first.client, "alice", 1, POST, { cache });
  assert.equal(first.calls.length, 4);
  assert.equal(p1.cached, false);

  const second = makeClient(handler);
  const p2 = await buildProfile(second.client, "Alice", 1, POST, { cache });
  assert.equal(second.calls.length, 0);
  assert.equal(p2.cached, true);
  assert.deepEqual([p2.targetPostsBefore, p2.targetCommentsBefore], [1, 2]);
  assert.deepEqual(Object.fromEntries(p2.subreddits), Object.fromEntries(p1.subreddits));

  // A different history window is a different question.
  const third = makeClient(handler);
  await buildProfile(third.client, "alice", 1, POST, { cache, after: POST.createdUtc - 86400 * 400 });
  assert.equal(third.calls.length, 4);
});

test("cached results expire", async () => {
  const { cache, clock } = makeCache();
  const handler = aggregates({ comments: [["rust", 4]] });
  await buildProfile(makeClient(handler).client, "alice", 1, POST, { cache });
  clock.t += 8 * 86400;
  const again = makeClient(handler);
  const p = await buildProfile(again.client, "alice", 1, POST, { cache });
  assert.equal(again.calls.length, 2);
  assert.equal(p.cached, false);
});

test("saved lifetime totals older than the user's last comment here don't justify skipping", async () => {
  const handler = aggregates({ comments: [["Python", 2]], before: { posts: 0, comments: 1 } });
  // Day 3: alice has 1 comment in the thread and 2 in r/Python, so "before" is asked for.
  const { cache, clock } = makeCache(POST.createdUtc + 3 * 86400);
  const first = await buildProfile(makeClient(handler).client, "alice", 1, POST, {
    cache, lastCommentUtc: POST.createdUtc + 2 * 86400,
  });
  assert.equal(first.targetCommentsBefore, 1);

  // Day 5: she has 4 comments here now, so the saved total of 2 no longer covers them.
  // The saved "before" answer is reused rather than skipping to 0.
  clock.t = POST.createdUtc + 5 * 86400;
  const opts = { cache, lastCommentUtc: POST.createdUtc + 4.5 * 86400 };
  const rescan = makeClient(handler);
  const p = await buildProfile(rescan.client, "alice", 4, POST, opts);
  assert.equal(rescan.calls.length, 0);
  assert.equal(p.targetCommentsBefore, 1);
  assert.equal(p.cached, true);

  // Without a saved answer, both "before" queries are made.
  cache.backend.map.delete(`v2|before|alice|python|${POST.createdUtc}|all`);
  const fresh = makeClient(handler);
  const p2 = await buildProfile(fresh.client, "alice", 4, POST, opts);
  assert.equal(fresh.calls.length, 2);
  assert.ok(fresh.calls.every((u) => u.searchParams.has("before")));
  assert.equal(p2.targetCommentsBefore, 1);
});

test("before counts saved within an hour of the post are fetched again", async () => {
  const { cache, clock } = makeCache(POST.createdUtc + 600);
  await buildProfile(makeClient(aggregates({ comments: [["Python", 3]], before: { posts: 0, comments: 1 } })).client,
    "bob", 1, POST, { cache, lastCommentUtc: POST.createdUtc + 300 });
  clock.t = POST.createdUtc + 3 * 86400;
  const later = makeClient(aggregates({ comments: [["Python", 3]], before: { posts: 0, comments: 2 } }));
  const p = await buildProfile(later.client, "bob", 1, POST, { cache, lastCommentUtc: POST.createdUtc + 300 });
  assert.equal(later.calls.length, 2);
  assert.equal(p.targetCommentsBefore, 2);
  assert.equal(p.cached, false);
});

test("broken or old-format saved records are ignored", async () => {
  const { cache } = makeCache();
  const map = cache.backend.map;
  const t = POST.createdUtc + 30 * 86400;
  map.set("v1|life|alice|all", { value: [[null, 1, 2]], fetchedAt: t });
  map.set(`v2|before|alice|python|${POST.createdUtc}|all`, { value: { posts: "x" }, fetchedAt: t });
  const { client, calls } = makeClient(aggregates({ comments: [["Python", 5]], before: { posts: 0, comments: 3 } }));
  const p = await buildProfile(client, "alice", 1, POST, { cache, lastCommentUtc: POST.createdUtc + 60 });
  assert.equal(calls.length, 3); // 2 lifetime + the comments-before query
  assert.equal(p.targetCommentsBefore, 3);
  assert.equal(p.cached, false);
  // A record with no usable fetchedAt never counts as fresh.
  map.set("v1|life|bob|all", { value: [] });
  assert.equal(await cache.get("v1|life|bob|all"), null);
});

test("partial lifetime counts from the only fallback aren't cached", async () => {
  const { cache } = makeCache();
  const handler = (u) => {
    if (isInteractions(u)) return notSupported();
    return u.searchParams.get("subreddit") ? json({ data: [] }) : json({ error: "Query timed out" });
  };
  await buildProfile(makeClient(handler).client, "busy", 1, POST, { cache, only: ["rust"] });
  assert.equal(await cache.get("v1|life|busy|all"), null);
});

test("ProfileCache is off with 0 days and clears", async () => {
  const off = new ProfileCache({ ttlDays: 0 });
  await off.set("k", 1);
  assert.equal(await off.get("k"), null);
  const on = new ProfileCache({ ttlDays: 1 });
  await on.set("a", [1]);
  await on.set("b", [2]);
  assert.deepEqual((await on.get("a")).value, [1]);
  assert.equal(await on.clear(), 2);
  assert.equal(await on.get("a"), null);
});

test("toCsv writes one row per user and subreddit, with the badge columns at the end", () => {
  const profiles = [
    {
      username: "alice", threadComments: 3, targetPostsBefore: 1, targetCommentsBefore: 4, error: null,
      subreddits: new Map([["rust", { posts: 1, comments: 0 }], ["Python", { posts: 2, comments: 10 }], ["big", { posts: 0, comments: 5 }]]),
    },
    { username: "ghost", threadComments: 1, targetPostsBefore: 0, targetCommentsBefore: 0, error: null, subreddits: new Map() },
    { username: "busy", threadComments: 2, targetPostsBefore: 0, targetCommentsBefore: 0, error: "Query timed out, sorry", subreddits: new Map() },
  ];
  assert.equal(
    toCsv(profiles, POST, 2),
    [
      "username,thread_comments,target_subreddit,target_posts_before,target_comments_before,subreddit,posts,comments,total,error," +
        "target_active_days_before,target_first_before_utc,target_badge",
      "alice,3,Python,1,4,Python,2,10,12,,,,occasional", // no timeline saved: judged by count
      "alice,3,Python,1,4,big,0,5,5,,,,occasional",
      "ghost,1,Python,0,0,,,,,,0,,new",
      'busy,2,Python,,,,,,,"Query timed out, sorry",,,',
      "",
    ].join("\r\n"),
  );
});

test("Stop cuts a rate-limit pause short", async () => {
  const controller = new AbortController();
  const client = new ArcticShiftClient({
    delay: 0, signal: controller.signal, fetchFn: async () => json({ error: "Too many requests" }, 429),
  });
  const started = Date.now();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(client.getPost("abc123"), Aborted);
  assert.ok(Date.now() - started < 2000, "should not wait out the 30 s pause");
});

test("Stop releases requests queued for a slot", async () => {
  const controller = new AbortController();
  const client = new ArcticShiftClient({
    delay: 0, maxInFlight: 1, signal: controller.signal,
    // Never answers; rejects only when its own request is aborted.
    fetchFn: (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
  });
  const first = client.getPost("a");
  const queued = client.getPost("b");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(client._waiters.length, 1);
  controller.abort();
  await assert.rejects(first, Aborted);
  await assert.rejects(queued, Aborted);
});

test("Stop while a response downloads doesn't look like a server error", async () => {
  const controller = new AbortController();
  const sleeps = [];
  const client = new ArcticShiftClient({
    delay: 0, signal: controller.signal, sleep: async (s) => sleeps.push(s),
    fetchFn: async () => ({
      status: 200, ok: true, headers: new Headers(),
      json: async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      },
    }),
  });
  await assert.rejects(client.getPost("abc123"), Aborted);
  assert.deepEqual(sleeps, []);
});

test("a server that keeps saying slow down fails the user without heavier fallbacks", async () => {
  const { client, calls } = makeClient(() => json({ data: null, error: "Timeout. Maybe slow down a bit" }, 422));
  await assert.rejects(buildProfile(client, "alice", 1, POST), ServerBusy);
  assert.equal(calls.length, 2 * (client.maxRetries + 1)); // each kind's query, and no more
  assert.ok(!calls.some(isInteractions));
});

test("a 4xx that isn't JSON fails at once, with its status", async () => {
  const { client, calls, sleeps } = makeClient(() => new Response("<html>Not found</html>", { status: 404 }));
  const err = await client.getPost("abc123").catch((e) => e);
  assert.ok(err instanceof ArcticShiftError);
  assert.equal(err.status, 404);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test("an interactions query that keeps failing falls through to the split", async () => {
  const { client, calls, clock } = makeClient((u) => {
    if (isInteractions(u)) return json({ error: "Internal error" }, 500);
    if (u.pathname.includes("/posts/")) return json({ data: [] });
    return u.searchParams.has("after") ? json({ data: [{ key: "rust", count: "1" }] }) : json({ error: "Query timed out" });
  });
  clock.t = Date.UTC(2024, 5, 1) / 1000;
  const p = await buildProfile(client, "busy", 1, POST);
  assert.equal(calls.filter(isInteractions).length, client.maxRetries + 1);
  assert.equal(p.subreddits.get("rust").comments, yearlyRanges(null, client._now()).length);
});

test("aggregate rows that can't be counts are skipped", async () => {
  const { client } = makeClient(() => json({
    data: [{ key: null, count: "3" }, { key: "rust", count: "many" }, { key: "go", count: "2" }, null],
  }));
  assert.deepEqual([...(await client.subredditCounts("comments", "alice"))], [["go", 2]]);
});

test("a very deep reply chain is walked without overflowing", async () => {
  let node = t1("c9999", "u9999");
  for (let i = 9998; i >= 0; i--) node = t1(`c${i}`, `u${i % 3}`, [node]);
  // Built as an object: JSON.stringify itself can't go that deep.
  const client = new ArcticShiftClient({
    delay: 0,
    fetchFn: async () => ({ status: 200, ok: true, headers: new Headers(), json: async () => ({ data: [node] }) }),
  });
  const counts = await collectCommenters(client, POST);
  assert.equal([...counts.values()].reduce((n, c) => n + c.count, 0), 10000);
});

test("threads too big for one tree response are paged straight away", async () => {
  const { client, calls } = makeClient(() => json({ data: [] }));
  await collectCommenters(client, { ...POST, numComments: 30_000 });
  assert.equal(calls[0].pathname, "/api/comments/search");
});

test("parseSubreddits takes URLs and trailing slashes, and drops invalid names", () => {
  assert.deepEqual(
    parseSubreddits(["r/rust/", "https://www.reddit.com/r/golang/comments/x/y/", "old.reddit.com/r/Zig", "c++", "a", ""]),
    ["rust", "golang", "Zig"],
  );
});

test("parsePostRef explains app share links", () => {
  assert.throws(() => parsePostRef("https://www.reddit.com/r/Python/s/AbCdEf123"), /share links/);
});

test("a lowered cap applies to requests already waiting for their start", async () => {
  const clock = { t: 0 };
  const gates = [];
  let active = 0;
  let peak = 0;
  const client = new ArcticShiftClient({
    delay: 0, maxInFlight: 2, now: () => clock.t,
    sleep: (s) => new Promise((resolve) => gates.push(() => { clock.t += s; resolve(); })),
    fetchFn: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return json({ data: [] });
    },
  });
  // Both requests take a slot, then wait out a pause; the cap drops to 1 meanwhile.
  client._pause(10, "test");
  const both = Promise.all([client._get("/a", {}), client._get("/b", {})]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(client._inFlight, 2);
  client._congested();
  while (gates.length) gates.shift()();
  await both;
  assert.equal(peak, 1);
});

test("a saved-results store that hangs is given up on", async () => {
  const hung = new Promise(() => {});
  const cache = new ProfileCache({
    backend: { get: () => hung, set: () => hung, clear: () => hung, prune: () => hung }, timeoutMs: 20,
  });
  assert.equal(await cache.get("k"), null);
  assert.equal(cache.enabled, false);
  await cache.set("k", 1); // returns at once now
});

test("prune deletes old and broken records", async () => {
  const backend = new MemoryBackend();
  const now = 100 * 86400;
  const cache = new ProfileCache({ backend, ttlDays: 7, now: () => now });
  await backend.set("new", { value: 1, fetchedAt: now - 86400 });
  await backend.set("old", { value: 1, fetchedAt: now - 40 * 86400 });
  await backend.set("broken", { value: 1 });
  assert.equal(await cache.prune(), 2); // older than max(7, 30) days, and no fetchedAt
  assert.deepEqual([...backend.map.keys()], ["new"]);
});

test("arcticSearchUrl links to an author's items in a subreddit", () => {
  const u = new URL(arcticSearchUrl("comments", "Some-User_1", "AskReddit"));
  assert.equal(u.origin + u.pathname, "https://arctic-shift.photon-reddit.com/search");
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    fun: "comments_search", author: "Some-User_1", subreddit: "AskReddit", limit: "100", sort: "desc",
  });
  const p = new URL(arcticSearchUrl("posts", "a", "rust", 1600000000));
  assert.equal(p.searchParams.get("fun"), "posts_search");
  assert.equal(p.searchParams.get("after"), "1600000000");
});

test("Eta estimates from the pace of fetched users and counts down between them", () => {
  let t = 1000;
  const eta = new Eta(10, () => t);
  t += 4; eta.record();
  t += 4; eta.record();
  assert.equal(eta.secondsLeft(), null); // not enough samples yet
  t += 4; eta.record();
  assert.equal(eta.secondsLeft(), 28); // 7 left at 4 s each
  t += 2;
  assert.equal(eta.secondsLeft(), 26); // counts down between completions
  t += 30; // the next user is badly overdue: the estimate grows instead of sitting at 0
  assert.ok(eta.secondsLeft() > 26);
  for (let i = 0; i < 7; i++) eta.record();
  assert.equal(eta.secondsLeft(), 0);
});

test("Eta ignores saved results for the pace and expects the same share later", () => {
  let t = 0;
  const eta = new Eta(20, () => t);
  for (let i = 0; i < 4; i++) {
    eta.record(true); // instant
    t += 5;
    eta.record();
  }
  // 12 left, half expected to be saved: 6 fetches at 5 s each.
  assert.equal(eta.secondsLeft(), 30);
});

test("Eta takes its pace from recent users only", () => {
  let t = 0;
  const eta = new Eta(100, () => t);
  for (let i = 0; i < 30; i++) { t += 10; eta.record(); } // slow start
  for (let i = 0; i < Eta.WINDOW; i++) { t += 1; eta.record(); } // server sped up
  assert.equal(eta.secondsLeft(), 50); // 50 left at 1 s each
});

test("Eta with only saved results so far waits for samples", () => {
  let t = 0;
  const eta = new Eta(10, () => t);
  for (let i = 0; i < 5; i++) eta.record(true);
  assert.equal(eta.secondsLeft(), null);
});

test("Eta leaves rate-limit pauses out of the pace and adds the rest of one in progress", () => {
  let t = 0;
  const eta = new Eta(10, () => t);
  for (let i = 0; i < 4; i++) { t += 2; eta.record(); } // 2 s each, 6 left
  eta.pause(t + 30);
  t += 10;
  assert.equal(eta.secondsLeft(), 12 + 20); // no progress while paused, plus 20 s of pause left
  t += 20; // pause over
  assert.equal(eta.secondsLeft(), 12);
  t += 2; eta.record();
  assert.equal(eta.secondsLeft(), 10); // 5 left, still 2 s each: the pause isn't in the pace
});

test("client reports shared pauses", async () => {
  const { client, clock } = makeClient(
    sequence(() => json({ error: "Too many requests" }, 429), () => json({ data: [] })));
  const pauses = [];
  client.onPause = (until) => pauses.push(until - clock.t);
  await client.subredditCounts("comments", "u");
  assert.deepEqual(pauses, [30]);
});

test("sortedSubreddits can put the post's subreddit first", () => {
  const profile = { subreddits: new Map([["AskReddit", { posts: 1, comments: 40 }], ["python", { posts: 0, comments: 2 }], ["rust", { posts: 0, comments: 9 }]]) };
  const post = { subreddit: "Python" };
  assert.deepEqual(sortedSubreddits(profile, post).map((s) => s.name), ["AskReddit", "rust", "python"]);
  assert.deepEqual(sortedSubreddits(profile, post, 5, { targetFirst: true }).map((s) => s.name), ["python", "AskReddit", "rust"]);
});

test("badges weigh how much, on how many days and since when", () => {
  const facts = (n, days, tenureDays) => ({ n, days, tenureDays });
  // Defaults: occasional 3+ on 2+ days from 14+ days back; regular 20+ on 8+ days from 90+.
  assert.equal(activityTier(facts(0, 0, null)), "new");
  assert.equal(activityTier(facts(40, 5, 6)), "new"); // a burst in the week before the post
  assert.equal(activityTier(facts(40, 30, 300)), "regular"); // spread over most of a year
  assert.equal(activityTier(facts(40, 3, 400)), "occasional"); // one old comment, then a burst
  assert.equal(activityTier(facts(5, 4, 200)), "occasional");
  // 0 turns a check off; unknown facts skip theirs.
  const loose = { occasional: { count: 1, days: 0, tenure: 0 }, regular: { count: 10, days: 0, tenure: 0 } };
  assert.equal(activityTier(facts(1, 1, 0), loose), "occasional");
  assert.equal(activityTier(facts(0, 0, null), { ...loose, occasional: { count: 0, days: 0, tenure: 0 } }), "new");
  assert.equal(activityTier(facts(25, null, null)), "regular");
});

test("badge rules round-trip as six numbers and reject junk", () => {
  assert.equal(formatBadges(DEFAULT_BADGES), "3,2,14,20,8,90");
  assert.deepEqual(parseBadges(" 1, 0,7 ,30,10,365"), {
    occasional: { count: 1, days: 0, tenure: 7 }, regular: { count: 30, days: 10, tenure: 365 },
  });
  for (const junk of ["", "1,2,3", "1,2,3,4,5,x", "1,2,3,4,5,-6", "1,2,3,4,5,6,7", null]) assert.equal(parseBadges(junk), null);
  assert.ok(sameBadges(parseBadges("3,2,14,20,8,90"), DEFAULT_BADGES));
});

test("saved-scan facts give tier counts under any rules", () => {
  const facts = badgeFacts(sampleProfiles(), POST);
  assert.deepEqual(facts, [[11, 11, 200], [0, 0, null], null]);
  assert.deepEqual(tierCounts(facts), { new: 1, occasional: 1, regular: 0 });
  assert.deepEqual(tierCounts(facts, parseBadges("1,1,1,10,10,100")), { new: 1, occasional: 0, regular: 1 });
});

const sampleProfiles = () => [
  { username: "a", threadComments: 3, targetPostsBefore: 2, targetCommentsBefore: 9, rank: 0,
    targetFirstBefore: POST.createdUtc - 200 * 86400, targetDaysBefore: 11, targetTimelineComplete: true,
    subreddits: new Map([["Python", { posts: 2, comments: 30 }], ["rust", { posts: 0, comments: 4 }]]) },
  { username: "b", threadComments: 1, targetPostsBefore: 0, targetCommentsBefore: 0, rank: 1, cached: true,
    subreddits: new Map([["python", { posts: 0, comments: 1 }], ["Empty", { posts: 0, comments: 0 }]]) },
  { username: "c", threadComments: 1, targetPostsBefore: 0, targetCommentsBefore: 0, rank: 2,
    subreddits: new Map(), error: "Arctic Shift is overloaded", errorDetail: "slow down" },
];

test("profiles survive serialization for saved scans", () => {
  for (const p of sampleProfiles()) {
    const back = deserializeProfile(JSON.parse(JSON.stringify(serializeProfile(p))));
    const timeline = { targetFirstBefore: null, targetDaysBefore: null, targetTimelineComplete: true };
    assert.deepEqual(back, { ...timeline, ...p, cached: Boolean(p.cached) });
  }
});

test("scanStats counts tiers, failures and distinct active subreddits", () => {
  assert.deepEqual(scanStats(sampleProfiles(), POST), {
    profiled: 3, failed: 1, new: 1, occasional: 1, regular: 0, subreddits: 2, posts: 2, comments: 35,
  });
  assert.equal(scanStats(sampleProfiles(), POST, true, parseBadges("1,1,1,10,10,100")).regular, 1);
  const outside = scanStats(sampleProfiles(), POST, false);
  assert.equal(outside.regular + outside.occasional + outside.new, 0);
});

test("ScanStore saves, lists newest first, loads, replaces and deletes scans", async () => {
  const store = new ScanStore();
  const rows = sampleProfiles().map(serializeProfile);
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.save({ id: "p1", scannedAt: 100, title: "old" }, rows), true);
  await store.save({ id: "p2", scannedAt: 200 }, rows.slice(0, 1));
  assert.deepEqual((await store.list()).map((s) => s.id), ["p2", "p1"]);
  await store.save({ id: "p1", scannedAt: 300, title: "new" }, rows); // a rescan replaces
  assert.deepEqual((await store.list()).map((s) => s.id), ["p1", "p2"]);
  const rec = await store.load("p1");
  assert.equal(rec.summary.title, "new");
  assert.equal(rec.profiles.length, 3);
  await store.delete("p1");
  assert.equal(await store.load("p1"), null);
  assert.equal(await store.clear(), 1);
  assert.deepEqual(await store.list(), []);
});

test("ScanStore gives up on a store that hangs", async () => {
  const hang = () => new Promise(() => {});
  const store = new ScanStore({ backend: { getPrefix: hang, set: hang, get: hang, delete: hang, clear: hang }, timeoutMs: 10 });
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.save({ id: "x", scannedAt: 1 }, []), false);
});

test("before facts come from one timestamp search per kind", async () => {
  const { client, calls } = makeClient(aggregates({
    comments: [["Python", 9]], posts: [["Python", 2]],
    beforeTimes: { comments: [...daily(3), POST.createdUtc - 40 * 86400 + 60], posts: [POST.createdUtc - 3600] },
  }));
  const p = await buildProfile(client, "alice", 1, POST);
  const before = calls.filter((u) => u.searchParams.has("before"));
  assert.equal(before.length, 2);
  for (const u of before) {
    assert.ok(u.pathname.endsWith("/search"));
    assert.deepEqual([u.searchParams.get("fields"), u.searchParams.get("sort"), u.searchParams.get("limit")], ["created_utc", "desc", "100"]);
  }
  assert.deepEqual([p.targetPostsBefore, p.targetCommentsBefore], [1, 4]);
  // Days: 3 daily comments, one 40 days back, and a post in the last day before the post.
  assert.equal(p.targetDaysBefore, 5);
  assert.equal(p.targetFirstBefore, POST.createdUtc - 40 * 86400 + 60);
  assert.equal(p.targetTimelineComplete, true);
});

test("past 100 items the count and first date take a query each", async () => {
  const many = daily(250);
  const { client, calls } = makeClient(aggregates({ comments: [["Python", 300]], beforeTimes: { comments: many } }));
  const p = await buildProfile(client, "busy", 1, POST);
  assert.equal(p.targetCommentsBefore, 250);
  assert.equal(p.targetFirstBefore, Math.min(...many));
  assert.equal(p.targetDaysBefore, 100); // the newest 100: a lower bound
  assert.equal(p.targetTimelineComplete, false);
  assert.equal(calls.filter((u) => u.searchParams.has("before")).length, 3);
});

test("if the timestamp search fails, the count still comes from the aggregate", async () => {
  const handler = aggregates({ comments: [["Python", 9]], before: { comments: 6 } });
  const { client } = makeClient((u) => (u.pathname === "/api/comments/search" ? json({ error: "Internal error" }, 500) : handler(u)));
  const p = await buildProfile(client, "alice", 1, POST);
  assert.equal(p.targetCommentsBefore, 6);
  assert.equal(p.targetDaysBefore, null);
  assert.equal(p.targetFirstBefore, null);
});

test("saved before facts are reused, old count-only records are not", async () => {
  const { cache } = makeCache();
  cache.backend.map.set(`v1|before|alice|python|${POST.createdUtc}|all`, { value: { posts: 0, comments: 3 }, fetchedAt: POST.createdUtc + 86400 });
  const handler = aggregates({ comments: [["Python", 9]], before: { comments: 4 } });
  const first = makeClient(handler);
  const p1 = await buildProfile(first.client, "alice", 1, POST, { cache });
  assert.equal(p1.targetCommentsBefore, 4); // the v1 record was ignored
  const again = makeClient(handler);
  const p2 = await buildProfile(again.client, "alice", 1, POST, { cache });
  assert.equal(again.calls.length, 0);
  assert.deepEqual([p2.targetDaysBefore, p2.targetFirstBefore], [4, POST.createdUtc - 4 * 86400]);
});

test("every request is tagged with meta-app", async () => {
  const { client, calls } = makeClient(() => json({ data: [] }));
  await client.getPost("abc123");
  await client.timestamps("comments", "alice", { subreddit: "Python" });
  assert.deepEqual(calls.map((u) => u.searchParams.get("meta-app")), ["reddit-post-profiler", "reddit-post-profiler"]);
});

test("estimateScan counts saved users and prices the rest", async () => {
  const { cache } = makeCache();
  const handler = aggregates({ posts: [["Python", 1]], comments: [["rust", 2]] });
  await buildProfile(makeClient(handler).client, "alice", 1, POST, { cache });
  const est = await estimateScan(cache, ["Alice", "bob", "carol"], { delay: 0.5, concurrency: 3 });
  assert.deepEqual(est, { users: 3, saved: 1, requests: 1 + 2 * 4, seconds: 9 * 1.3 });
  // The window is part of the key: nothing saved for the last year.
  const windowed = await estimateScan(cache, ["alice"], { after: POST.createdUtc - 365 * 86400, delay: 2 });
  assert.deepEqual(windowed, { users: 1, saved: 0, requests: 4, seconds: 8 });
  assert.equal((await estimateScan(null, ["a"], { concurrency: 1 })).seconds, 4 * 1.8);
  assert.ok(LARGE_SCAN > 0);
});

const savedScan = () => {
  const profiles = sampleProfiles().map(serializeProfile);
  return {
    summary: {
      id: POST.id, post: { ...POST, numComments: 5 }, scannedAt: POST.createdUtc + 86400, complete: true, total: 3,
      thread: { comments: 5, people: 3 }, requests: 9, seconds: 12.5, profilingSeconds: 10, fromSaved: 1, after: null,
      beforeKnown: true, opts: { only: [], years: null, maxUsers: null, includeOp: false, exclude: [] },
      stats: { bogus: true }, facts: "bogus",
    },
    profiles,
  };
};

test("saved scans round-trip through an export file, with stats worked out again", () => {
  const text = exportScans([savedScan()], 123);
  const { scans, invalid } = parseScanExport(text);
  assert.equal(invalid, 0);
  assert.equal(scans.length, 1);
  const [{ summary, profiles }] = scans;
  assert.deepEqual(profiles, savedScan().profiles);
  assert.deepEqual(summary.stats, scanStats(sampleProfiles(), summary.post));
  assert.deepEqual(summary.facts, badgeFacts(sampleProfiles(), summary.post));
  assert.equal(summary.seconds, 12.5);
  // Exports from before the rename still import.
  const old = text.replace('"kind":"rpp-saved-scans"', '"kind":"reddit-tool-saved-scans"');
  assert.notEqual(old, text);
  assert.equal(parseScanExport(old).scans.length, 1);
});

test("imported scans are checked", () => {
  assert.throws(() => parseScanExport("not json"), /isn't JSON/);
  assert.throws(() => parseScanExport(JSON.stringify({ scans: [] })), /isn't a saved-scans export/);
  assert.throws(() => parseScanExport(exportScans([]).replace('"version":1', '"version":99')), /newer version/);
  const bad = [
    (s) => (s.summary.post.id = "NOT AN ID!"),
    (s) => (s.summary.id = "other1"),
    (s) => (s.summary.post.subreddit = "a/b"),
    (s) => (s.profiles[0].username = "<img>"),
    (s) => (s.profiles[0].subreddits[0][1] = "3"),
    (s) => (s.profiles[1].targetFirstBefore = "yesterday"),
    (s) => (s.profiles = "x"),
  ];
  for (const spoil of bad) {
    const scan = savedScan();
    spoil(scan);
    assert.equal(importScan(scan), null, spoil.toString());
  }
  const { scans, invalid } = parseScanExport(exportScans([savedScan(), { summary: null }]));
  assert.deepEqual([scans.length, invalid], [1, 1]);
  // Odd optional fields are tidied, not trusted.
  const odd = savedScan();
  Object.assign(odd.summary, { requests: "lots", total: 1, opts: { years: 3, only: ["ok", "no way"], maxUsers: -1 } });
  const { summary } = importScan(odd);
  assert.deepEqual([summary.requests, summary.total, summary.opts.years, summary.opts.only, summary.opts.maxUsers], [0, 3, null, ["ok"], null]);
});

test("ScanStore exports every scan and imports only newer copies", async () => {
  const store = new ScanStore();
  const scan = importScan(savedScan());
  await store.save(scan.summary, scan.profiles);
  assert.deepEqual(await store.exportAll(), [scan]);
  const older = { ...scan, summary: { ...scan.summary, scannedAt: scan.summary.scannedAt - 1 } };
  const newer = { ...scan, summary: { ...scan.summary, scannedAt: scan.summary.scannedAt + 1 } };
  const other = { ...scan, summary: { ...scan.summary, id: "zzz999", post: { ...scan.summary.post, id: "zzz999" } } };
  assert.deepEqual(await store.importAll([older, newer, other]), { added: 1, replaced: 1, kept: 1, failed: 0 });
  assert.equal((await store.load(POST.id)).summary.scannedAt, newer.summary.scannedAt);
  assert.equal((await store.list()).length, 2);
});
