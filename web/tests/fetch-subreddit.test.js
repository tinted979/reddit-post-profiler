// The archive sync's fetcher (tools/fetch_subreddit.mjs): one subreddit's posts or comments
// after a time, through the page's ArcticShiftClient, for the splice builder (docs/adr/0005).
// Every request goes to a fake API; nothing here reaches the network.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { APP_TAG, ArcticShiftClient } from "../core.js";
import { ARCHIVE_TAG, SETTLE, USER_AGENT, archiveClient, fetchSubreddit, main, parseArgs } from "../../tools/fetch_subreddit.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// 250 comments in r/Python, three a second from 1000 on, so pages of 100 end mid-second.
const COMMENTS = Array.from({ length: 250 }, (_, i) => ({
  id: `c${i.toString(36)}`,
  author: `user${i % 7}`,
  created_utc: 1000 + Math.floor(i / 3),
  subreddit: "Python",
  link_id: "t3_abc",
  body: "not asked for",
}));
const POSTS = COMMENTS.slice(0, 40).map((c, i) => ({ id: `p${i.toString(36)}`, author: c.author, created_utc: c.created_utc, subreddit: "Python" }));

// A search endpoint over `rows`: subreddit (any case), after and before (both exclusive),
// oldest first, `limit` rows, only the `fields` asked for. For `limit=auto` the real server
// answers 100-1000 rows by its capacity (API README): here `autoSize`, a number or a function of
// the request number (from 1). `fail(n, url)` can answer request n instead. Records each
// request's URL, User-Agent, clock time and requests in flight.
function fakeApi({ posts = POSTS, comments = COMMENTS, clock = null, autoSize = 100, fail = () => null } = {}) {
  const requests = [];
  let inFlight = 0;
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    inFlight++;
    requests.push({ url: u, userAgent: new Headers(init.headers).get("user-agent"), at: clock?.now() ?? null, inFlight });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      const failed = fail(requests.length, u);
      if (failed) return failed;
      const kind = u.pathname.match(/^\/api\/(posts|comments)\/search$/)?.[1];
      if (!kind) return json({ error: "unknown endpoint" }, 404);
      const q = u.searchParams;
      const after = q.has("after") ? Number(q.get("after")) : -Infinity;
      const before = q.has("before") ? Number(q.get("before")) : Infinity;
      const limit = q.get("limit") === "auto" ? (typeof autoSize === "function" ? autoSize(requests.length) : autoSize) : Number(q.get("limit"));
      const fields = q.get("fields")?.split(",");
      const data = (kind === "posts" ? posts : comments)
        .filter((r) => r.subreddit.toLowerCase() === q.get("subreddit").toLowerCase() && r.created_utc > after && r.created_utc < before)
        .sort((a, b) => a.created_utc - b.created_utc)
        .slice(0, limit)
        .map((r) => (fields ? Object.fromEntries(fields.map((f) => [f, r[f]])) : r));
      return json({ data });
    } finally {
      inFlight--;
    }
  };
  return { fetchFn, requests };
}

// A clock that only moves when the client sleeps.
function fakeClock(t = 5000) {
  const clock = { now: () => t, sleep: async (seconds) => { t += seconds; } };
  return clock;
}

const WINDOW = { subreddit: "Python", kind: "comments", after: 999, before: 2000, budget: 10 };

test("an ArcticShiftClient tags requests with its appTag, and with the page's own by default", async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(new URL(url));
    return json({ data: [] });
  };
  await new ArcticShiftClient({ fetchFn, delay: 0 }).getPost("abc123");
  await new ArcticShiftClient({ fetchFn, delay: 0, appTag: "another-tag" }).getPost("abc123");
  assert.deepEqual(urls.map((u) => u.searchParams.get("meta-app")), [APP_TAG, "another-tag"]);
});

test("the sync's client sends one request at a time, a second apart, tagged as the sync and with a User-Agent", async () => {
  const clock = fakeClock();
  const { fetchFn, requests } = fakeApi({ clock });
  const client = archiveClient({ fetchFn, now: clock.now, sleep: clock.sleep });
  await fetchSubreddit(client, WINDOW);
  await fetchSubreddit(client, { ...WINDOW, kind: "posts" });
  assert.equal(requests.length, 4); // 3 pages of comments, 1 of posts
  assert.equal(ARCHIVE_TAG, "reddit-post-profiler-archive");
  for (const [i, r] of requests.entries()) {
    const kind = i < 3 ? "comments" : "posts";
    assert.equal(r.url.origin + r.url.pathname, `https://arctic-shift.photon-reddit.com/api/${kind}/search`);
    assert.equal(r.url.searchParams.get("meta-app"), ARCHIVE_TAG);
    assert.equal(r.userAgent, USER_AGENT);
    assert.equal(r.url.searchParams.get("fields"), kind === "comments" ? "id,author,created_utc,link_id" : "id,author,created_utc");
    assert.deepEqual(
      ["subreddit", "before", "sort", "limit"].map((k) => r.url.searchParams.get(k)),
      ["Python", "2000", "asc", "auto"],
    );
    assert.equal(r.inFlight, 1);
    if (i) assert.ok(r.at - requests[i - 1].at >= 1, `request ${i} came ${r.at - requests[i - 1].at} s after the last`);
  }
});

test("a fetch that reaches the end has every row between after and before, and is complete to the second before `before`", async () => {
  const { fetchFn, requests } = fakeApi();
  const clock = fakeClock();
  const { rows, result } = await fetchSubreddit(archiveClient({ fetchFn, ...clock }), WINDOW);
  assert.deepEqual(result, {
    subreddit: "Python", kind: "comments", after: 999, before: 2000,
    pages: 3, requests: 3, items: 250, skipped: 0,
    reached_end: true, complete_through: 1999, error: null, busy: false,
  });
  assert.deepEqual(rows.map((r) => r.id), COMMENTS.map((c) => c.id));
  // Only the columns the build reads: the subreddit is the one asked about.
  assert.deepEqual(rows[0], { id: "c0", author: "user0", created_utc: 1000, subreddit: "Python", link_id: "t3_abc" });
  // Each page starts a second before the last one ended, so a second split across pages is whole.
  assert.deepEqual(requests.map((r) => r.url.searchParams.get("after")), ["999", "1032", "1065"]);
});

test("pages are as large as the server gives: 100-1000 rows, as the download tool asks for", async () => {
  const many = Array.from({ length: 2500 }, (_, i) => ({ ...COMMENTS[0], id: `m${i.toString(36)}`, created_utc: 1000 + Math.floor(i / 2) }));
  const { fetchFn, requests } = fakeApi({ comments: many, autoSize: 1000 });
  const { rows, result } = await fetchSubreddit(archiveClient({ fetchFn, ...fakeClock() }), { ...WINDOW, before: 3000 });
  assert.deepEqual(rows.map((r) => r.id), many.map((r) => r.id));
  // Pages of 1000, 1000 and 504 rows, then one under 100: 4 requests, where 100-row pages take 26.
  assert.deepEqual([result.pages, result.requests, result.reached_end, result.complete_through], [4, 4, true, 2999]);
  assert.ok(requests.every((r) => r.url.searchParams.get("limit") === "auto"));
});

test("a page the server sized at its capacity isn't taken for the end; one under 100 rows is", async () => {
  // Pages of 100, 350 and 1000 rows while more remain, then what's left.
  const sizes = [100, 350, 1000, 1000];
  const many = Array.from({ length: 1500 }, (_, i) => ({ ...COMMENTS[0], id: `v${i.toString(36)}`, created_utc: 1000 + Math.floor(i / 2) }));
  const { fetchFn, requests } = fakeApi({ comments: many, autoSize: (n) => sizes[n - 1] });
  const { rows, result } = await fetchSubreddit(archiveClient({ fetchFn, ...fakeClock() }), { ...WINDOW, before: 3000 });
  assert.deepEqual(rows.map((r) => r.id), many.map((r) => r.id));
  assert.equal(result.reached_end, true);
  assert.deepEqual(requests.map((r) => r.url.searchParams.get("after")), ["999", "1048", "1222", "1721"]);
});

test("the page's own paging with limit=auto still ends only on an empty page", async () => {
  // shortBelow is the fetcher's opt-in; the page's thread paging keeps its old end rule.
  const { fetchFn, requests } = fakeApi({ autoSize: 1000 });
  const client = new ArcticShiftClient({ fetchFn, delay: 0 });
  const rows = [];
  for await (const page of client.iterAscending("/api/comments/search", { subreddit: "Python", after: 999, before: 2000 })) rows.push(...page);
  assert.equal(rows.length, 250);
  assert.equal(requests.length, 3); // 250 rows, the last second again (nothing new), then an empty page
});

test("an empty window ends on its first page, complete to the second before `before`", async () => {
  const { fetchFn, requests } = fakeApi();
  const { rows, result } = await fetchSubreddit(archiveClient({ fetchFn, ...fakeClock() }), { ...WINDOW, after: 1500 });
  assert.deepEqual(rows, []);
  assert.deepEqual([result.pages, result.items, result.reached_end, result.complete_through], [1, 0, true, 1999]);
  assert.equal(requests.length, 1);
});

test("with no `after`, the fetch starts from the subreddit's first row", async () => {
  const { fetchFn, requests } = fakeApi();
  const { result } = await fetchSubreddit(archiveClient({ fetchFn, ...fakeClock() }), { ...WINDOW, kind: "posts", after: null });
  assert.equal(requests[0].url.searchParams.has("after"), false);
  assert.deepEqual([result.after, result.items, result.reached_end], [null, 40, true]);
});

test("a fetch the budget stops is complete to the second before its newest row, and a resume from there fills the rest", async () => {
  const { fetchFn } = fakeApi();
  const first = await fetchSubreddit(archiveClient({ fetchFn, ...fakeClock() }), { ...WINDOW, budget: 1 });
  // One page: rows 0-99, the last at 1033, where row 100 is still to come.
  assert.deepEqual([first.result.pages, first.result.reached_end, first.result.complete_through], [1, false, 1032]);
  // Rows of the second it stopped in are left for the next fetch, so the file holds exactly
  // the rows from `after` to complete_through.
  assert.equal(first.result.items, 99);
  assert.ok(first.rows.every((r) => r.created_utc <= 1032));

  const second = await fetchSubreddit(archiveClient({ fetchFn, ...fakeClock() }), { ...WINDOW, after: first.result.complete_through });
  assert.equal(second.result.reached_end, true);
  const ids = [...first.rows, ...second.rows].map((r) => r.id);
  assert.deepEqual(ids, COMMENTS.map((c) => c.id));
});

test("a busy server stops the fetch with what it had, and nothing more is sent", async () => {
  const slowDown = (n) => (n > 1 ? json({ error: "Timeout. Maybe slow down a bit" }, 422) : null);
  const { fetchFn, requests } = fakeApi({ fail: slowDown });
  const client = archiveClient({ fetchFn, ...fakeClock() });
  const { rows, result } = await fetchSubreddit(client, WINDOW);
  assert.equal(result.busy, true);
  assert.match(result.error, /server busy/);
  assert.deepEqual([result.pages, result.reached_end, result.complete_through, result.items], [1, false, 1032, 99]);
  assert.equal(rows.length, 99);
  // The first page, then the one retried until the client gave up: the same search each time.
  assert.equal(result.requests, requests.length);
  assert.ok(requests.every((r) => r.url.pathname === "/api/comments/search"));
  assert.ok(requests.slice(1).every((r) => r.url.searchParams.get("after") === "1032"));
});

test("a query that times out stops the fetch with what it had, and isn't counted as a busy server", async () => {
  const timeout = (n) => (n === 2 ? json({ error: "Query timed out" }, 422) : null);
  const { fetchFn, requests } = fakeApi({ fail: timeout });
  const { result } = await fetchSubreddit(archiveClient({ fetchFn, ...fakeClock() }), WINDOW);
  assert.deepEqual([result.busy, result.reached_end, result.complete_through, result.items], [false, false, 1032, 99]);
  assert.match(result.error, /timed out/);
  assert.equal(requests.length, 2);
});

test("rows the API shouldn't send are dropped or cleaned, never written as they came", async () => {
  const odd = [
    { id: "../x", author: "a", created_utc: 1500, link_id: "t3_abc" }, // not an id
    { id: "ok1", author: "a", created_utc: "soon", link_id: "t3_abc" }, // no time
    { id: "ok2", author: "a", created_utc: 999, link_id: "t3_abc" }, // at `after`, which is exclusive
    { id: "ok3", author: "a", created_utc: 2000, link_id: "t3_abc" }, // at `before`
    { id: "ok4", author: 42, created_utc: 1500, link_id: "t3_../../x" }, // odd author and link
    { id: "ok5", author: "bob", created_utc: "1501.7", link_id: "zz9", extra: "<b>" },
  ];
  const fetchFn = async () => json({ data: odd });
  const { rows, result } = await fetchSubreddit(archiveClient({ fetchFn, ...fakeClock() }), WINDOW);
  assert.deepEqual(rows, [
    { id: "ok4", author: null, created_utc: 1500, subreddit: "Python", link_id: null },
    { id: "ok5", author: "bob", created_utc: 1501, subreddit: "Python", link_id: "zz9" },
  ]);
  assert.equal(result.skipped, 4);
  assert.equal(result.items, 2);
});

test("parseArgs checks every argument, and `before` defaults to a minute ago", () => {
  const now = 1_800_000_000;
  const base = ["--subreddit", "Hasan_Piker", "--kind", "comments", "--budget", "50", "--out", "c.jsonl", "--result", "c.json"];
  assert.deepEqual(parseArgs([...base, "--after", "1700000000"], now), {
    subreddit: "Hasan_Piker", kind: "comments", after: 1_700_000_000, before: now - SETTLE, budget: 50, out: "c.jsonl", result: "c.json", help: false,
  });
  assert.equal(SETTLE, 60);
  assert.equal(parseArgs(base, now).after, null);
  assert.equal(parseArgs([...base, "--before", String(now - 3600)], now).before, now - 3600);
  assert.equal(parseArgs(["--help"], now).help, true);
  const bad = [
    ["--subreddit", "../etc"],
    ["--subreddit", "a"],
    ["--kind", "users"],
    ["--after", "-5"],
    ["--after", "1e9"],
    ["--before", String(now)], // less than a minute ago: rows may still be arriving
    ["--after", "1700000000", "--before", "1700000000"],
    ["--budget", "0"],
    ["--budget", "ten"],
    ["--result", "c.jsonl"], // the same file as --out
    ["--unknown", "x"],
  ];
  for (const args of bad) {
    const argv = [...base];
    for (let i = 0; i < args.length; i += 2) {
      const at = argv.indexOf(args[i]);
      if (at >= 0) argv.splice(at, 2, args[i], args[i + 1]);
      else argv.push(args[i], args[i + 1]);
    }
    assert.throws(() => parseArgs(argv, now), Error, args.join(" "));
  }
  for (const missing of ["--subreddit", "--kind", "--budget", "--out", "--result"]) {
    const argv = [...base];
    argv.splice(argv.indexOf(missing), 2);
    assert.throws(() => parseArgs(argv, now), Error, `without ${missing}`);
  }
});

test("main writes the rows as JSON lines, then the result, sending requests only through the fetch it's given", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rpp-fetch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let globalCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    globalCalls++;
    throw new Error("no network in tests");
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const { fetchFn, requests } = fakeApi();
  const clock = fakeClock(2000 + SETTLE);
  const out = join(dir, "posts.jsonl");
  const result = join(dir, "result.json");
  const logs = [];
  const code = await main(
    ["--subreddit", "python", "--kind", "posts", "--after", "999", "--budget", "5", "--out", out, "--result", result],
    { fetchFn, ...clock, log: (line) => logs.push(line) },
  );
  assert.equal(code, 0);
  assert.equal(globalCalls, 0);
  assert.equal(requests.length, 1);
  const lines = readFileSync(out, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 40);
  assert.deepEqual(lines[0], { id: "p0", author: "user0", created_utc: 1000, subreddit: "python" });
  const written = JSON.parse(readFileSync(result, "utf8"));
  assert.deepEqual([written.before, written.items, written.reached_end, written.complete_through], [2000, 40, true, 1999]);
  assert.ok(logs.some((line) => /40 posts/.test(line)), logs.join("\n"));
});

test("main exits 3 after an API error, with the partial result written, and 2 on bad arguments, writing nothing", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rpp-fetch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "c.jsonl");
  const result = join(dir, "c.json");
  const args = ["--subreddit", "Python", "--kind", "comments", "--after", "999", "--before", "2000", "--budget", "5", "--out", out, "--result", result];
  const busy = fakeApi({ fail: (n) => (n > 1 ? json({ error: "Timeout. Maybe slow down a bit" }, 422) : null) });
  const code = await main(args, { fetchFn: busy.fetchFn, ...fakeClock(3000), log: () => {} });
  assert.equal(code, 3);
  const written = JSON.parse(readFileSync(result, "utf8"));
  assert.deepEqual([written.busy, written.complete_through, written.items], [true, 1032, 99]);
  assert.equal(readFileSync(out, "utf8").trimEnd().split("\n").length, 99);

  rmSync(out);
  rmSync(result);
  const never = fakeApi();
  const errors = [];
  const bad = await main(["--subreddit", "../x", ...args.slice(2)], { fetchFn: never.fetchFn, ...fakeClock(3000), log: () => {}, error: (line) => errors.push(line) });
  assert.equal(bad, 2);
  assert.equal(never.requests.length, 0);
  assert.equal(existsSync(out) || existsSync(result), false);
  assert.match(errors.join("\n"), /subreddit/);
});
