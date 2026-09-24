import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Aborted,
  ArcticShiftClient,
  ArcticShiftError,
  buildProfile,
  collectCommenters,
  mapPool,
  parsePostRef,
  parseSubreddits,
  toCsv,
  yearlyRanges,
} from "../core.js";

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
    id: "abc123", author: "op", subreddit: "Python", createdUtc: 1700000000, title: "Hi",
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
  assert.deepEqual(calls.map((u) => u.searchParams.get("after")), [null, "499", "501", "502"]);
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
  assert.deepEqual(sleeps, [5, 10]);
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
  const counts = await collectCommenters(client, POST, { exclude: ["u/spambot"], includeOp: true });
  assert.deepEqual([...counts], [["alice", 2], ["bob", 1], ["op_user", 0]]);
});

test("buildProfile merges case-insensitively and fetches before counts", async () => {
  const { client } = makeClient((u) => {
    const kind = u.pathname.includes("/posts/") ? "posts" : "comments";
    if (u.searchParams.has("subreddit")) {
      assert.equal(u.searchParams.get("before"), String(POST.createdUtc));
      return json({ data: kind === "posts" ? [{ key: "Python", count: "1" }] : [{ key: "Python", count: "4" }] });
    }
    return json({
      data: kind === "posts"
        ? [{ key: "Python", count: "2" }, { key: "rust", count: "1" }]
        : [{ key: "python", count: "10" }, { key: "AskReddit", count: "5" }],
    });
  });
  const p = await buildProfile(client, "alice", 3, POST);
  assert.equal(p.targetPostsBefore, 1);
  assert.equal(p.targetCommentsBefore, 4);
  assert.deepEqual(Object.fromEntries(p.subreddits), {
    Python: { posts: 2, comments: 10 }, rust: { posts: 1, comments: 0 }, AskReddit: { posts: 0, comments: 5 },
  });
});

test("buildProfile skips before queries the lifetime counts rule out", async () => {
  const { client, calls } = makeClient((u) => {
    assert.ok(!u.searchParams.has("before"), "unexpected before query");
    return u.pathname.includes("/posts/")
      ? json({ data: [{ key: "rust", count: "4" }] })
      : json({ data: [{ key: "python", count: "2" }, { key: "rust", count: "9" }] });
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
    if (u.searchParams.has("before")) {
      assert.ok(u.pathname.includes("/comments/"));
      return json({ data: [{ key: "Python", count: "3" }] });
    }
    return u.pathname.includes("/posts/")
      ? json({ data: [{ key: "Python", count: "1" }] })
      : json({ data: [{ key: "Python", count: "5" }] });
  });
  const p = await buildProfile(client, "OP_User", 2, POST);
  assert.equal(calls.length, 3);
  assert.equal(p.targetPostsBefore, 0);
  assert.equal(p.targetCommentsBefore, 3);
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
  await Promise.all([client.subredditCounts("posts", "a"), client.subredditCounts("posts", "b")]);
  // Both start at once; the 429 pauses the retry *and* anything queued behind it.
  assert.equal(starts[0], 1000);
  assert.ok(starts.slice(2).every((t) => t >= 1030), `starts: ${starts}`);
  assert.ok(sleeps.includes(30));
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
  const { client, calls } = makeClient((u) =>
    u.pathname.includes("/posts/")
      ? json({ data: [{ key: "rust", count: "4" }, { key: "funny", count: "1" }] })
      : json({ data: [{ key: "python", count: "2" }, { key: "AskReddit", count: "9" }] }),
  );
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
    return json({ data: [{ key: "Python", count: "9" }] });
  });
  const p = await buildProfile(client, "alice", 1, POST, { after });
  assert.equal(calls.length, 4);
  assert.equal(p.targetCommentsBefore, 9);
});

test("buildProfile skips before queries for a post older than the window", async () => {
  const { client, calls } = makeClient(() => json({ data: [{ key: "Python", count: "9" }] }));
  const p = await buildProfile(client, "alice", 1, POST, { after: POST.createdUtc + 1 });
  assert.equal(calls.length, 2);
  assert.equal(p.targetPostsBefore + p.targetCommentsBefore, 0);
});

test("yearlyRanges starts at the window", () => {
  const after = Date.UTC(2020, 5, 1) / 1000;
  const ranges = yearlyRanges(Date.UTC(2022, 0, 1) / 1000, 0, after);
  assert.deepEqual(ranges, [[after, Date.UTC(2021, 0, 1) / 1000], [Date.UTC(2021, 0, 1) / 1000, Date.UTC(2022, 0, 1) / 1000]]);
});

test("toCsv matches the CLI layout", () => {
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
      "username,thread_comments,target_subreddit,target_posts_before,target_comments_before,subreddit,posts,comments,total,error",
      "alice,3,Python,1,4,Python,2,10,12,",
      "alice,3,Python,1,4,big,0,5,5,",
      "ghost,1,Python,0,0,,,,,",
      'busy,2,Python,,,,,,,"Query timed out, sorry"',
      "",
    ].join("\r\n"),
  );
});
