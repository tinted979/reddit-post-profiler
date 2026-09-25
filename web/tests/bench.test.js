import assert from "node:assert/strict";
import { test } from "node:test";

import { SCENARIOS, apiModel, runScenarios } from "../bench/scan-bench.mjs";
import { APP_TAG, BASE_URL } from "../core.js";

// Everything but the wall time, which is the one number allowed to vary.
const counts = ({ wallMs, ...rest }) => rest;

test("the scan bench is deterministic and makes no real network calls", async (t) => {
  const realFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async (...args) => {
    networkCalls++;
    return realFetch(...args);
  };
  let first;
  let second;
  try {
    first = await runScenarios();
    second = await runScenarios();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(networkCalls, 0, "the bench called the global fetch");
  assert.deepEqual(first.unexpected, [], "the bench sent a request its models don't expect");
  assert.deepEqual(counts(second), counts(first));
  assert.ok(Number.isFinite(first.wallMs));
  assert.deepEqual(first.scenarios.map((s) => s.name), SCENARIOS.map((s) => s.name));
  // The numbers, in the test log, as `node bench/scan-bench.mjs` prints them.
  t.diagnostic(JSON.stringify(first));
});

test("the bench's API model records anything it doesn't expect", async () => {
  const unexpected = [];
  const api = apiModel({ user: "alice" }, unexpected);
  const ok = new URL(`${BASE_URL}/api/posts/search/aggregate?aggregate=subreddit&author=alice&limit=&meta-app=${APP_TAG}`);
  assert.equal(api(ok).status, 200);
  assert.deepEqual(unexpected, []);
  for (const url of [
    "https://elsewhere.example/api/posts/search/aggregate?aggregate=subreddit&author=alice",
    `${BASE_URL}/api/posts/search/aggregate?aggregate=subreddit&author=alice`, // no meta-app
    `${BASE_URL}/api/posts/search/aggregate?aggregate=subreddit&author=bob&meta-app=${APP_TAG}`,
    `${BASE_URL}/api/comments/tree?link_id=x&author=alice&meta-app=${APP_TAG}`,
  ]) {
    assert.equal(api(new URL(url)).status, 400, url);
  }
  assert.equal(unexpected.length, 4);
});

test("the scan bench covers the paths it's meant to measure", async () => {
  const { scenarios } = await runScenarios();
  const by = Object.fromEntries(scenarios.map((s) => [s.name, s]));
  const hits = (name, path) => by[name].api.byEndpoint[path] ?? 0;

  assert.equal(hits("light", "/api/posts/search/aggregate"), 1);
  assert.equal(hits("light", "/api/comments/search/aggregate"), 1);
  assert.equal(hits("light", "/api/comments/search"), 1);

  // Past 100 "before" comments: the aggregate gives the count and an asc search the first date.
  assert.equal(hits("before-over-100", "/api/comments/search"), 2);
  assert.equal(hits("before-over-100", "/api/comments/search/aggregate"), 2);
  assert.equal(by["before-over-100"].result.commentsBefore, 240);
  assert.equal(by["before-over-100"].result.timelineComplete, false);

  assert.equal(hits("lifetime-timeout", "/api/users/interactions/subreddits"), 1);
  assert.equal(by["lifetime-timeout-warm"].api.total, 0);
  assert.equal(by["lifetime-timeout-warm"].result.cached, true);

  for (const name of ["archive-before", "archive-only"]) {
    const { archive } = by[name];
    assert.equal(archive.manifest, 1, name);
    assert.ok(archive.rangeReads > 0 && archive.bytes > 0, `${name} read the archive files`);
  }
  assert.equal(hits("archive-only", "/api/users/interactions/subreddits"), 1);
  assert.equal(hits("archive-only", "/api/posts/search/aggregate"), 0);

  for (const s of scenarios) {
    const sum = Object.values(s.api.byEndpoint).reduce((a, b) => a + b, 0);
    assert.equal(s.api.total, sum, `${s.name}: total matches the per-endpoint counts`);
  }
});
