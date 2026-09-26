// Full scans ask each commenter's lifetime counts with one interactions query first, and fall
// back to the two aggregates only when it can't answer (docs/adr/0007; the owner's benchmark,
// tools/lifetime_bench.mjs, found them identical for 50 of 50 users, and faster). `app.js`
// turns it on with buildProfile's `interactionsFirst`; without it, the aggregates go first.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ArcticShiftClient, buildProfile, estimateScan } from "../core.js";
import { MemoryBackend, ProfileCache } from "../cache.js";

const NOW = 1_800_000_000;
const POST = { id: "abc123", author: "op_user", subreddit: "Python", createdUtc: 1_790_000_000, title: "t", numComments: 3 };
const W = 1_000_000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// A client served by `handler(url)` on a simulated clock. Records every URL.
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

const path = (u) => u.pathname.replace("/api/", "").replace("/search/aggregate", " aggregate");

// alice: 2 posts and 5 comments in r/Python (3 comments before the post), 1 comment in r/rust.
// `interactions` answers with those counts, or as told: "unsupported" (a 400, as for huge
// accounts), "timeout", "busy" (a "slow down" every time) or "rate limited" (a 429).
function api({ interactions = "ok", aggregates = "ok" } = {}) {
  return (u) => {
    if (u.pathname === "/api/users/interactions/subreddits") {
      if (interactions === "unsupported") return json({ error: "not supported" }, 400);
      if (interactions === "timeout") return json({ error: "Query timed out" }, 422);
      if (interactions === "busy") return json({ error: "Timeout. Maybe slow down a bit" }, 422);
      if (interactions === "rate limited") return new Response("", { status: 429, headers: { "X-RateLimit-Reset": "1" } });
      return json({ data: [{ subreddit: "python", count: 2 * W + 5 }, { subreddit: "rust", count: 1 }] });
    }
    const agg = u.pathname.match(/^\/api\/(posts|comments)\/search\/aggregate$/);
    if (agg && !u.searchParams.has("subreddit")) {
      if (aggregates === "timeout" && !u.searchParams.has("after")) return json({ error: "Query timed out" }, 422);
      const rows = agg[1] === "posts" ? [{ key: "Python", count: 2 }] : [{ key: "Python", count: 5 }, { key: "rust", count: 1 }];
      return json({ data: rows });
    }
    if (agg) return json({ data: [{ key: "Python", count: agg[1] === "posts" ? 2 : 3 }] });
    // "Before" timestamps in r/Python.
    if (/^\/api\/(posts|comments)\/search$/.test(u.pathname)) {
      const times = u.pathname.includes("/posts/") ? [POST.createdUtc - 500, POST.createdUtc - 400] : [POST.createdUtc - 300, POST.createdUtc - 200, POST.createdUtc - 100];
      return json({ data: times.map((t) => ({ created_utc: t })) });
    }
    return json({ error: "unexpected" }, 400);
  };
}

const lifetime = (calls) => calls.filter((u) => /interactions|aggregate/.test(u.pathname) && !u.searchParams.has("subreddit")).map(path);

test("with interactionsFirst, one interactions query answers the lifetime counts, up to the post", async () => {
  const { client, calls } = makeClient(api());
  const p = await buildProfile(client, "alice", 1, POST, { interactionsFirst: true, after: POST.createdUtc - 10 * 365 * 86400 });
  assert.deepEqual(lifetime(calls), ["users/interactions/subreddits"]);
  const q = calls[0].searchParams;
  assert.deepEqual([q.get("before"), q.get("after")], [String(POST.createdUtc), String(POST.createdUtc - 10 * 365 * 86400)]);
  // Subreddit names merge whatever their case: the post's r/Python is found as r/python.
  assert.deepEqual(Object.fromEntries(p.subreddits), { python: { posts: 2, comments: 5 }, rust: { posts: 0, comments: 1 } });
  assert.deepEqual([p.targetPostsBefore, p.targetCommentsBefore], [2, 3]);
  // Then only the "before" searches: 3 requests where aggregates first took 4.
  assert.equal(calls.length, 3);
});

test("the answer is saved like any lifetime counts, so the next scan of the post asks nothing for them", async () => {
  const cache = new ProfileCache({ backend: new MemoryBackend(), now: () => NOW });
  await buildProfile(makeClient(api()).client, "alice", 1, POST, { interactionsFirst: true, cache });
  const again = makeClient(api());
  const p = await buildProfile(again.client, "alice", 1, POST, { interactionsFirst: true, cache });
  assert.equal(again.calls.length, 0);
  assert.deepEqual(p.subreddits.get("python"), { posts: 2, comments: 5 });
});

for (const refusal of ["unsupported", "timeout"]) {
  test(`interactions that can't answer (${refusal}) hand over to the two aggregates, and aren't asked again`, async () => {
    const { client, calls } = makeClient(api({ interactions: refusal }));
    const p = await buildProfile(client, "alice", 1, POST, { interactionsFirst: true });
    assert.deepEqual(lifetime(calls), ["users/interactions/subreddits", "posts aggregate", "comments aggregate"]);
    assert.deepEqual(Object.fromEntries(p.subreddits), { Python: { posts: 2, comments: 5 }, rust: { posts: 0, comments: 1 } });
  });
}

test("when the aggregates time out too, only the timed-out kinds are split, with no second interactions query", async () => {
  const { client, calls } = makeClient(api({ interactions: "unsupported", aggregates: "timeout" }));
  const p = await buildProfile(client, "alice", 1, POST, { interactionsFirst: true });
  const asked = lifetime(calls);
  assert.equal(asked.filter((x) => x.includes("interactions")).length, 1);
  // Each kind: the unfiltered aggregate twice (it times out), then a query per year.
  assert.ok(calls.some((u) => u.pathname.includes("aggregate") && u.searchParams.has("after")), "split by year");
  assert.deepEqual(p.subreddits.get("Python"), { posts: 2 * (asked.filter((x) => x === "posts aggregate").length - 2), comments: 5 * (asked.filter((x) => x === "comments aggregate").length - 2) });
});

for (const refusal of ["busy", "rate limited"]) {
  test(`a server that's ${refusal} fails the user rather than being sent the heavier aggregates`, async () => {
    const { client, calls } = makeClient(api({ interactions: refusal }));
    await assert.rejects(buildProfile(client, "alice", 1, POST, { interactionsFirst: true }));
    assert.ok(!calls.some((u) => u.pathname.includes("aggregate")));
  });
}

test("without interactionsFirst the aggregates still go first, as before", async () => {
  const { client, calls } = makeClient(api());
  await buildProfile(client, "alice", 1, POST);
  assert.deepEqual(lifetime(calls), ["posts aggregate", "comments aggregate"]);
});

test("estimateScan prices a new user at one request fewer with interactionsFirst", async () => {
  const users = ["a1", "b2", "c3"];
  const first = await estimateScan(null, users, { before: POST.createdUtc });
  const second = await estimateScan(null, users, { before: POST.createdUtc, interactionsFirst: true });
  assert.deepEqual([first.requests, second.requests], [12, 9]);
  assert.ok(second.seconds < first.seconds);
});

test("the scan bench models the page's way: one interactions query where the aggregates took two", async () => {
  const { runScenarios } = await import("../bench/scan-bench.mjs");
  const { scenarios, unexpected } = await runScenarios();
  const by = Object.fromEntries(scenarios.map((s) => [s.name, s]));
  const hits = (name, p) => by[name].api.byEndpoint[p] ?? 0;
  assert.deepEqual(unexpected, []);
  assert.equal(hits("light-interactions", "/api/users/interactions/subreddits"), 1);
  assert.equal(hits("light-interactions", "/api/posts/search/aggregate") + hits("light-interactions", "/api/comments/search/aggregate"), 0);
  assert.equal(by["light-interactions"].api.total, by.light.api.total - 1);
  assert.deepEqual(by["light-interactions"].result, by.light.result);
  // Refused: the two aggregates answer, and the result is the same.
  assert.equal(hits("interactions-refused", "/api/users/interactions/subreddits"), 1);
  assert.equal(hits("interactions-refused", "/api/posts/search/aggregate"), 1);
  assert.deepEqual(by["interactions-refused"].result, by.light.result);
});
