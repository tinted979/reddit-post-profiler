// The lifetime-count benchmark (tools/lifetime_bench.mjs): for P8, whether one interactions
// query can stand in for the two aggregates a scan asks first. It runs against a fake API
// here; the owner runs it live.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { benchClient, compareCounts, main, parseArgs, runBench, summarize } from "../../tools/lifetime_bench.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const POST = { id: "abc123", author: "op_user", subreddit: "Python", created_utc: 1_790_000_000, title: "t", num_comments: 4 };
// Per user: what each aggregate and interactions answer.
const USERS = {
  alice: { posts: { Python: 2 }, comments: { Python: 5, rust: 1 }, interactions: { python: [2, 5], rust: [0, 1] } },
  bob: { posts: {}, comments: { Python: 3 }, interactions: { Python: [0, 4] } }, // one more comment
  carol: { posts: { Python: 1 }, comments: "timeout", interactions: { Python: [1, 900] } },
  dave: { posts: { Python: 1 }, comments: { Python: 1 }, interactions: "unsupported" },
};
const THREAD = ["alice", "bob", "carol", "dave"].map((a, i) => ({
  kind: "t1", data: { id: `c${i}`, author: a, created_utc: POST.created_utc + 60 + i, replies: "" },
}));

// The API above on a clock that only moves when the client sleeps or a request answers
// (each takes `latency[path kind]` ms). Records each request's path and parameters.
function fakeApi({ latency = { aggregate: 400, interactions: 300 }, busyAfter = Infinity } = {}) {
  const requests = [];
  let t = 0;
  const clock = { now: () => t / 1000, sleep: async (s) => { t += s * 1000; }, ms: () => t };
  const fetchFn = async (url) => {
    const u = new URL(url);
    const q = Object.fromEntries(u.searchParams);
    requests.push({ path: u.pathname, q });
    if (requests.length > busyAfter) return json({ error: "Timeout. Maybe slow down a bit" }, 422);
    if (u.pathname === "/api/posts/ids") return json({ data: [POST] });
    if (u.pathname === "/api/comments/tree") return json({ data: THREAD });
    const user = USERS[q.author];
    const agg = u.pathname.match(/^\/api\/(posts|comments)\/search\/aggregate$/);
    if (agg) {
      t += latency.aggregate;
      const answer = user[agg[1]];
      if (answer === "timeout") return json({ error: "Query timed out" }, 422);
      return json({ data: Object.entries(answer).map(([key, count]) => ({ key, count })) });
    }
    if (u.pathname === "/api/users/interactions/subreddits") {
      t += latency.interactions;
      if (user.interactions === "unsupported") return json({ error: "not supported" }, 400);
      return json({ data: Object.entries(user.interactions).map(([subreddit, [p, c]]) => ({ subreddit, count: p * 1_000_000 + c })) });
    }
    return json({ error: "unknown" }, 404);
  };
  return { fetchFn, requests, clock };
}

// The benchmark's own client (the page's, one request at a time, timing each), on the fake.
function client(api) {
  return benchClient({ fetchFn: api.fetchFn, now: api.clock.now, sleep: api.clock.sleep, ms: api.clock.ms });
}

test("compareCounts ignores the case of subreddit names and empty counts, and lists what differs", () => {
  const agg = new Map([["Python", { posts: 2, comments: 5 }], ["rust", { posts: 0, comments: 0 }]]);
  const same = new Map([["python", { posts: 2, comments: 5 }]]);
  assert.deepEqual(compareCounts(agg, same), { agree: true, diffs: [] });
  const other = new Map([["python", { posts: 2, comments: 6 }], ["Go", { posts: 1, comments: 0 }]]);
  assert.deepEqual(compareCounts(agg, other), {
    agree: false,
    diffs: [
      { subreddit: "go", aggregates: { posts: 0, comments: 0 }, interactions: { posts: 1, comments: 0 } },
      { subreddit: "python", aggregates: { posts: 2, comments: 5 }, interactions: { posts: 2, comments: 6 } },
    ],
  });
});

test("each user gets both answers, with the same bounds, in alternating order", async () => {
  const api = fakeApi();
  const { records, stopped } = await runBench(client(api), ["alice", "bob"], { after: 1_700_000_000, before: POST.created_utc });
  assert.equal(stopped, null);
  const order = api.requests.map((r) => (r.path.includes("interactions") ? "I" : r.path.split("/")[2][0]));
  assert.deepEqual(order, ["p", "c", "I", "I", "p", "c"]);
  for (const r of api.requests) {
    assert.equal(r.q.before, String(POST.created_utc));
    assert.equal(r.q.after, "1700000000");
  }
  assert.deepEqual(records.map((r) => [r.user, r.order, r.agree]), [["alice", "aggregates first", true], ["bob", "interactions first", false]]);
  assert.deepEqual(records[1].diffs, [{ subreddit: "python", aggregates: { posts: 0, comments: 3 }, interactions: { posts: 0, comments: 4 } }]);
  assert.deepEqual([records[0].aggregates.ms, records[0].interactions.ms], [{ posts: 400, comments: 400 }, 300]);
});

test("a timeout or a refusal is recorded, and leaves agreement unknown", async () => {
  const api = fakeApi();
  const { records } = await runBench(client(api), ["carol", "dave"], { before: POST.created_utc });
  // carol: the comments aggregate timed out (a scan would then ask interactions), which answered.
  assert.deepEqual([records[0].aggregates.error, records[0].interactions.error, records[0].agree], ["timeout", null, null]);
  assert.equal(records[0].interactions.subreddits, 1);
  assert.deepEqual([records[1].aggregates.error, records[1].interactions.error, records[1].agree], [null, "unsupported", null]);
  // Asked as a scan asks first: a timed-out aggregate once more, then no split.
  assert.equal(api.requests.filter((r) => r.q.author === "carol" && r.path.includes("comments")).length, 2);
});

test("a busy reply stops the run even when the other aggregate had timed out", async () => {
  // carol's posts aggregate times out (aggregates go first for the first user), then the server
  // answers only "slow down": the busy reply must win over the timeout, and stop the run.
  const api = fakeApi({ busyAfter: 2 });
  const heavy = { ...USERS.carol, posts: "timeout" };
  const saved = USERS.carol;
  USERS.carol = heavy;
  try {
    const { records, stopped } = await runBench(client(api), ["carol", "alice"], { before: POST.created_utc });
    assert.match(stopped, /busy/);
    assert.equal(records[0].aggregates.error, "busy");
    assert.ok(!api.requests.some((r) => r.q.author === "alice"));
    assert.ok(!api.requests.some((r) => r.path.includes("interactions")));
  } finally {
    USERS.carol = saved;
  }
});

test("a busy server stops the run with what it has", async () => {
  const api = fakeApi({ busyAfter: 3 }); // alice's three answer, then only "slow down"
  const { records, stopped } = await runBench(client(api), ["alice", "bob", "carol"], { before: POST.created_utc });
  assert.match(stopped, /busy/);
  assert.deepEqual(records.map((r) => r.user), ["alice", "bob"]);
  assert.equal(records[1].interactions.error, "busy");
  assert.ok(!api.requests.some((r) => r.q.author === "carol"));
});

test("summarize gives agreement, errors, latency and the gate's verdict", async () => {
  const api = fakeApi();
  const { records } = await runBench(client(api), ["alice", "bob", "carol", "dave"], { before: POST.created_utc });
  const s = summarize(records);
  assert.deepEqual([s.users, s.bothAnswered, s.agree, s.agreement], [4, 2, 1, 0.5]);
  assert.deepEqual(s.errors, { aggregates: { timeout: 1 }, interactions: { unsupported: 1 } });
  assert.equal(s.interactionsWhereAggregatesTimedOut, 1);
  assert.deepEqual(s.latency.interactions, { median: 300, p90: 300 });
  assert.deepEqual(s.latency.aggregatesTogether, { median: 800, p90: 800 });
  assert.deepEqual(s.gate, { agreement: false, speed: true, slowdowns: true, pass: false });
});

test("latency compares the same users on both sides", () => {
  // A heavy user whose aggregates timed out and whose interactions query took 5 s would make
  // interactions look slow, though the aggregates never answered for them at all.
  const answered = (ms) => ({ ms, error: null, subreddits: 1, retries: 0 });
  const records = [
    { user: "a", agree: true, diffs: [], aggregates: answered({ posts: 400, comments: 400 }), interactions: answered(300) },
    { user: "heavy", agree: null, diffs: [], aggregates: { ms: { posts: 900, comments: 30000 }, error: "timeout", subreddits: null, retries: 0 },
      interactions: answered(5000) },
  ];
  const s = summarize(records);
  assert.deepEqual([s.latency.interactions.median, s.latency.aggregatesTogether.median], [300, 800]);
  assert.equal(s.gate.speed, true);
});

test("parseArgs checks its arguments", () => {
  assert.deepEqual(parseArgs(["--post", "https://www.reddit.com/r/Python/comments/abc123/x/", "--max", "20", "--years", "5"]), {
    post: "abc123", users: null, max: 20, years: 5, before: null, out: null, help: false,
  });
  assert.deepEqual(parseArgs(["--users", "alice, bob", "--before", "1790000000"]).users, ["alice", "bob"]);
  for (const bad of [[], ["--post", "abc123", "--users", "a"], ["--post", "nope!"], ["--post", "abc123", "--max", "0"],
    ["--post", "abc123", "--years", "x"], ["--users", "a", "--before", "soon"], ["--users", "../x"], ["--post", "abc123", "--odd", "1"]]) {
    assert.throws(() => parseArgs(bad), Error, bad.join(" "));
  }
});

test("main benchmarks a post's commenters and writes the results, through the fetch it's given", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rpp-bench-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const realFetch = globalThis.fetch;
  let globalCalls = 0;
  globalThis.fetch = async () => {
    globalCalls++;
    throw new Error("no network in tests");
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const api = fakeApi();
  const out = join(dir, "bench.json");
  const lines = [];
  const code = await main(["--post", "abc123", "--out", out], { fetchFn: api.fetchFn, now: api.clock.now, sleep: api.clock.sleep, ms: api.clock.ms, log: (l) => lines.push(l) });
  assert.equal(code, 0);
  assert.equal(globalCalls, 0);
  const saved = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(saved.before, POST.created_utc);
  assert.deepEqual(saved.records.map((r) => r.user).sort(), ["alice", "bob", "carol", "dave"]);
  assert.equal(saved.summary.gate.pass, false);
  // Every request carries the page's own tag.
  assert.ok(api.requests.every((r) => r.q["meta-app"] === "reddit-post-profiler"));
  assert.match(lines.join("\n"), /agree: 1 of 2/);
});
