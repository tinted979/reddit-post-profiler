// Offline scan benchmark: what buildProfile costs for a fixed set of users, from fixtures
// only. Every scenario runs with an injected fetch that answers from an in-memory model of
// the Arctic Shift API (and, for the archive scenarios, from web/tests/fixtures/dumps
// through DumpSource), on a virtual clock, so the counts are the same on every run and no
// request leaves the process. Any URL the model doesn't expect is recorded and makes the
// command exit non-zero.
//
//   node web/bench/scan-bench.mjs               one JSON document on stdout
//   node web/bench/scan-bench.mjs --base main   the same, run against `main` in a temporary
//                                                git worktree too, side by side
//
// Not part of the site: the deploy copies only web/*.{html,js,css}.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as core from "../core.js";
import { MemoryBackend, ProfileCache } from "../cache.js";
import { DumpSource } from "../dumps.js";

// A namespace import, so `--base` can run this script against code from before a function
// existed: scenarios that need a missing one are left out there.
const { APP_TAG, ArcticShiftClient, BASE_URL, DAY, SCAN_DEFAULTS, buildProfile } = core;

const FIXTURES = new URL("../tests/fixtures/dumps/", import.meta.url);
// Where the bench's archive "lives". Never contacted: DumpSource gets a local fetch.
const ARCHIVE_URL = "https://archive.bench.invalid";
// Simulated time each API request takes to answer, in seconds (measured against the live
// API with 2 or more users in parallel; see CLAUDE.md's API facts).
export const LATENCY = 1.3;
// POST_WEIGHT in core.js: an interactions count of p * W + c is p posts, c comments.
const W = 1_000_000;

// The post every scenario profiles a commenter of. Python is the subreddit the archive
// fixtures cover; they run to just before this post, so a covered lookup still asks the API
// about the gap.
export const POST = { id: "bench1", author: "op_user", subreddit: "Python", createdUtc: 1_700_000_000, title: "bench", numComments: 10 };


// n timestamps, one a day, the newest a day before `end`.
const daily = (n, end = POST.createdUtc) => Array.from({ length: n }, (_, i) => end - (i + 1) * DAY);

// A virtual clock with a timer queue. sleep(s) resolves when the clock reaches now + s;
// timers fire one at a time, earliest first (ties in the order they were set), once the
// work already scheduled has run, so parallel waits overlap as they would in real time.
function virtualClock(start = 1_000) {
  let t = start;
  let seq = 0;
  let scheduled = false;
  const timers = [];
  const fire = () => {
    scheduled = false;
    if (!timers.length) return;
    timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const next = timers.shift();
    t = Math.max(t, next.at);
    next.resolve();
    schedule();
  };
  const schedule = () => {
    if (!scheduled && timers.length) {
      scheduled = true;
      setImmediate(fire);
    }
  };
  return {
    now: () => t,
    sleep: (seconds) => new Promise((resolve) => {
      timers.push({ at: t + Math.max(0, seconds), seq: seq++, resolve });
      schedule();
    }),
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const within = (t, u) => {
  const after = u.searchParams.get("after");
  const before = u.searchParams.get("before");
  return (after === null || t > Number(after)) && (before === null || t < Number(before));
};

// An in-memory Arctic Shift for one user. `lifetime` is {posts, comments} as [[subreddit,
// n], …]; `before` the timestamps of their items in the post's subreddit; `recent` the
// interactions rows ([[subreddit, posts, comments], …]) answered for a query with `after`;
// `timeouts` makes the unfiltered lifetime aggregates time out; `tail` ({posts, comments}
// as [{id, author, created_utc, link_id}, …]) is everyone's activity in the post's
// subreddit, for subreddit-wide searches; `tree` ([[author, created_utc], …]) is the post's
// comment tree, and `thread` (rows like `tail`'s) its comments for a search by `link_id`.
// Anything else is unexpected: it's recorded in `unexpected` and answered with a 400.
export function apiModel({ user, lifetime = {}, before = {}, recent = [], timeouts = false, tail = null, tree = null, thread = null }, unexpected) {
  const refuse = (u) => {
    unexpected.push(u.toString());
    return json({ error: "unexpected request in the bench" }, 400);
  };
  return (u) => {
    if (u.origin !== new URL(BASE_URL).origin || u.searchParams.get("meta-app") !== APP_TAG) return refuse(u);
    if (tree && u.pathname === "/api/comments/tree") {
      return json({ data: tree.map(([author, t], i) => ({ kind: "t1", data: { id: `k${i}`, author, created_utc: t, replies: "" } })) });
    }
    if (thread && u.pathname === "/api/comments/search" && u.searchParams.has("link_id")) {
      const rows = thread.filter((r) => r.link_id === `t3_${u.searchParams.get("link_id")}` && within(r.created_utc, u))
        .sort((a, b) => a.created_utc - b.created_utc);
      return json({ data: rows.slice(0, Number(u.searchParams.get("limit"))) });
    }
    const whole = /^\/api\/(posts|comments)\/search$/.exec(u.pathname);
    if (tail && whole && !u.searchParams.has("author")) {
      const kind = whole[1];
      const fields = kind === "posts" ? "id,author,created_utc" : "id,author,created_utc,link_id";
      if (u.searchParams.get("subreddit")?.toLowerCase() !== POST.subreddit.toLowerCase() ||
        u.searchParams.get("fields") !== fields || u.searchParams.get("sort") !== "asc") return refuse(u);
      const rows = (tail[kind] ?? []).filter((r) => within(r.created_utc, u)).sort((a, b) => a.created_utc - b.created_utc);
      return json({ data: rows.slice(0, Number(u.searchParams.get("limit"))) });
    }
    if (u.searchParams.get("author")?.toLowerCase() !== user.toLowerCase()) return refuse(u);
    const m = /^\/api\/(posts|comments)\/search(\/aggregate)?$/.exec(u.pathname);
    if (m) {
      const [, kind, aggregate] = m;
      const sub = u.searchParams.get("subreddit");
      if (sub !== null && sub.toLowerCase() !== POST.subreddit.toLowerCase()) return refuse(u);
      const times = (before[kind] ?? []).filter((t) => within(t, u));
      if (aggregate) {
        if (u.searchParams.get("aggregate") !== "subreddit") return refuse(u);
        if (sub !== null) return json({ data: times.length ? [{ key: sub, count: times.length }] : [] });
        if (timeouts) return json({ error: "Query timed out" }, 422);
        return json({ data: (lifetime[kind] ?? []).map(([key, count]) => ({ key, count })) });
      }
      if (u.searchParams.get("fields") !== "created_utc" || sub === null) return refuse(u);
      const asc = u.searchParams.get("sort") === "asc";
      const sorted = [...times].sort((a, b) => (asc ? a - b : b - a));
      return json({ data: sorted.slice(0, Number(u.searchParams.get("limit"))).map((t) => ({ created_utc: t })) });
    }
    if (u.pathname === "/api/users/interactions/subreddits") {
      if (u.searchParams.get("weight_posts") !== String(W)) return refuse(u);
      let rows = recent;
      if (!u.searchParams.has("after")) {
        const merged = new Map();
        for (const [i, kind] of ["posts", "comments"].entries()) {
          for (const [sub, n] of lifetime[kind] ?? []) {
            const c = merged.get(sub) ?? [sub, 0, 0];
            c[i + 1] += n;
            merged.set(sub, c);
          }
        }
        rows = [...merged.values()];
      }
      return json({ data: rows.map(([subreddit, p, c]) => ({ subreddit, count: p * W + c })) });
    }
    return refuse(u);
  };
}

// The archive server, from the fixture files: the manifest, and byte ranges of the Parquet
// files. Counts range reads and the bytes they return.
function archiveServer(stats, unexpected) {
  return async (url, init = {}) => {
    const href = String(url);
    if (!href.startsWith(`${ARCHIVE_URL}/`)) {
      unexpected.push(href);
      throw new TypeError(`unexpected archive request: ${href}`);
    }
    const path = href.slice(ARCHIVE_URL.length + 1);
    if (path === "manifest.json") {
      stats.manifest++;
      return new Response(readFileSync(new URL("manifest.json", FIXTURES)));
    }
    if (!/^r\/\w+\/\w+\/\w+\.parquet$/.test(path)) {
      unexpected.push(href);
      return new Response("not found", { status: 404 });
    }
    const buf = readFileSync(new URL(path, FIXTURES));
    const range = /bytes=(\d+)-(\d*)/.exec(new Headers(init.headers).get("range") ?? "");
    const body = range ? buf.subarray(Number(range[1]), range[2] ? Number(range[2]) + 1 : buf.byteLength) : buf;
    stats.rangeReads++;
    stats.bytes += body.byteLength;
    return new Response(body, { status: range ? 206 : 200 });
  };
}

// The users. Each scenario profiles one, with the options a scan would pass.
const LIGHT = {
  user: "light_user",
  lifetime: { posts: [["Python", 1]], comments: [["Python", 4], ["rust", 2]] },
  before: { posts: daily(1), comments: daily(3) },
};
const HEAVY_BEFORE = {
  user: "heavy_before",
  lifetime: { posts: [["Python", 12]], comments: [["Python", 250], ["learnpython", 40]] },
  before: { posts: daily(12, POST.createdUtc - 3 * DAY), comments: daily(240) },
};
const TIMEOUTS = {
  user: "huge_account",
  timeouts: true,
  lifetime: { posts: [["Python", 3], ["AskReddit", 900]], comments: [["Python", 60], ["AskReddit", 40_000]] },
  before: { posts: daily(3), comments: daily(55) },
};
// alice is in the archive fixtures (1 post, 3 comments in r/Python); the API answers for
// what came after the files end.
// Every count stops at the post (docs/adr/0006): her comment in the thread isn't among them.
const ARCHIVED = {
  user: "alice",
  lifetime: { posts: [["Python", 1]], comments: [["Python", 4], ["rust", 7]] },
  before: { posts: [], comments: [1_699_998_000] },
  recent: [["Python", 0, 1], ["rust", 0, 1]],
};

// The same user once everyone's activity after the files end is fetched per scan: alice's
// comment before the post and one in the thread, among others'.
const others = (n, from, step) => Array.from({ length: n }, (_, i) => ({ id: `o${i}`, author: `other${i % 40}`, created_utc: from + i * step, link_id: "t3_elsewhere" }));
const ARCHIVED_TAIL = {
  ...ARCHIVED,
  tail: {
    posts: [],
    comments: [
      ...others(30, 1_699_990_000, 300),
      { id: "a1", author: "alice", created_utc: 1_699_998_000, link_id: "t3_elsewhere" },
      { id: "a2", author: "alice", created_utc: POST.createdUtc + 600, link_id: `t3_${POST.id}` },
    ],
  },
};
// The same, for a post a week after the files end: a busy subreddit's week of comments
// between them (~200 a day).
const STALE_TAIL = {
  ...ARCHIVED_TAIL,
  tail: { posts: [], comments: [...others(1_500, 1_699_990_000, 400), ...ARCHIVED_TAIL.tail.comments.slice(-2)] },
};

// The thread as the comment tree gives it: alice's comment, the one in ARCHIVED_TAIL's tail.
const TREE = [["Alice", 1_699_000_000], ["carol", 1_699_990_000]];
// Post p1 in the fixtures, older than where the files end: its thread is Alice's comment in
// the files and carol's, in their last hour, which the thread search gets again.
const P1 = { id: "p1", author: "Alice", createdUtc: 1_699_800_000, numComments: 2 };
const P1_THREAD = [{ id: "c4", author: "carol", created_utc: 1_699_990_000, link_id: "t3_p1" }];

// Seconds since the epoch the cache thinks it is: a month after the post, so saved
// answers count as fetched well after the thread.
const CACHE_NOW = POST.createdUtc + 30 * DAY;

export const SCENARIOS = Object.freeze([
  { name: "light", about: "a light user: two lifetime aggregates and one timestamp search per kind", world: LIGHT },
  { name: "before-over-100", about: "more than 100 \"before\" comments: search, then aggregate count + asc search", world: HEAVY_BEFORE },
  { name: "lifetime-timeout", about: "lifetime aggregates time out (twice each) and interactions answers", world: TIMEOUTS },
  { name: "lifetime-timeout-warm", about: "the same user again with a warm MemoryBackend cache", world: TIMEOUTS, warm: true },
  { name: "archive-before", about: "a subreddit the archive covers: \"before\" from the files, the gap from the API", world: ARCHIVED, archive: true },
  { name: "archive-only", about: "a scan limited to the covered subreddit: lifetime from the files + one interactions query", world: ARCHIVED, archive: true, only: ["Python"] },
  { name: "archive-tail-only", about: "the same scan after one fetch of the subreddit's activity since the files (per scan, not per user): nothing per user", world: ARCHIVED_TAIL, archive: true, tail: true, only: ["Python"] },
  { name: "archive-tail-full", about: "a full scan of a covered post after that fetch: only the two lifetime aggregates per user", world: ARCHIVED_TAIL, archive: true, tail: true },
  { name: "thread-tree", about: "collecting an older post's commenters without the archive: one comment tree request per scan", world: { ...ARCHIVED, tree: TREE }, thread: true, post: P1 },
  { name: "archive-thread", about: "the same with the archive: the thread's files plus one request for its comments after them, and nothing per user for a scan limited to it", world: { ...ARCHIVED, thread: P1_THREAD, tail: { posts: [], comments: [] } }, archive: true, tail: true, only: ["Python"], thread: true, post: P1 },
  { name: "archive-tail-stale", about: "a post a week after the files end (1,500 comments between): the tail's pages grow with the gap, but are still one set per scan", world: STALE_TAIL, archive: true, tail: true, only: ["Python"], post: { createdUtc: 1_699_990_000 + 7 * DAY, numComments: 1000 } },
]);

// One buildProfile on a fresh client. Returns the counts and the profile.
async function profileOnce(scenario, { cache = null, unexpected }) {
  const clock = virtualClock();
  const byEndpoint = {};
  const handler = apiModel(scenario.world, unexpected);
  const client = new ArcticShiftClient({
    delay: SCAN_DEFAULTS.delay,
    maxInFlight: SCAN_DEFAULTS.concurrency,
    fetchFn: async (url) => {
      const u = new URL(url);
      const whole = u.pathname.endsWith("/search") && u.searchParams.has("subreddit") && !u.searchParams.has("author");
      const key = whole ? `${u.pathname} (whole subreddit)` : u.pathname;
      byEndpoint[key] = (byEndpoint[key] ?? 0) + 1;
      await clock.sleep(LATENCY);
      return handler(u);
    },
    sleep: (s) => clock.sleep(s),
    now: clock.now,
    random: () => 0.5,
  });
  const archive = { manifest: 0, rangeReads: 0, bytes: 0 };
  const dumps = scenario.archive
    ? await DumpSource.open({ baseUrl: ARCHIVE_URL, fetchFn: archiveServer(archive, unexpected) })
    : null;
  if (scenario.archive && !dumps) throw new Error(`${scenario.name}: the fixture manifest gave no archive`);
  const post = { ...POST, ...scenario.post };
  const start = clock.now();
  // A scan's tail fetch (see fetchTails) runs a day after the post.
  if (scenario.tail) await core.fetchTails(client, dumps, post, { only: scenario.only ?? null, now: () => post.createdUtc + DAY });
  const commenters = scenario.thread ? await core.collectCommenters(client, post, { dumps }) : null;
  const threadComments = 1;
  const profile = await buildProfile(client, scenario.world.user, threadComments, post, {
    only: scenario.only ?? null,
    lastCommentUtc: POST.createdUtc + 600,
    cache,
    dumps,
  });
  const sorted = Object.fromEntries(Object.entries(byEndpoint).sort(([a], [b]) => a.localeCompare(b)));
  return {
    api: { total: client.requests, byEndpoint: sorted },
    archive,
    fakeSeconds: Math.round((clock.now() - start) * 1000) / 1000,
    result: {
      postsBefore: profile.targetPostsBefore,
      commentsBefore: profile.targetCommentsBefore,
      daysBefore: profile.targetDaysBefore,
      timelineComplete: profile.targetTimelineComplete,
      cached: profile.cached,
      subreddits: [...profile.subreddits].map(([name, c]) => [name, c.posts, c.comments]),
      ...(commenters && { commenters: Object.fromEntries(commenters) }),
    },
  };
}

// Replaces the global fetch while the bench runs, so a request that bypasses the injected
// fetch fails and is recorded instead of reaching the network.
async function withoutNetwork(unexpected, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    unexpected.push(`global fetch: ${url}`);
    throw new TypeError("the bench makes no network requests");
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

// Every scenario, in order: {scenarios: [{name, about, api, archive, fakeSeconds, result}],
// unexpected: [url, …], wallMs}.
export async function runScenarios() {
  const unexpected = [];
  const t0 = performance.now();
  const scenarios = await withoutNetwork(unexpected, async () => {
    const out = [];
    for (const scenario of SCENARIOS) {
      if (scenario.tail && !core.fetchTails) continue; // older code, from --base
      let cache = null;
      if (scenario.warm) {
        cache = new ProfileCache({ backend: new MemoryBackend(), ttlDays: 7, now: () => CACHE_NOW });
        await profileOnce(scenario, { cache, unexpected }); // fills the cache; not reported
      }
      out.push({ name: scenario.name, about: scenario.about, ...await profileOnce(scenario, { cache, unexpected }) });
    }
    return out;
  });
  return { scenarios, unexpected, wallMs: Math.round(performance.now() - t0) };
}

// Runs this script (the working tree's copy) against `ref` in a temporary worktree and
// returns its JSON. The worktree is removed afterwards, whatever happens.
function runAtRef(ref) {
  const here = fileURLToPath(import.meta.url);
  const git = (...args) => execFileSync("git", args, { cwd: dirname(here), encoding: "utf8" }).trim();
  const root = git("rev-parse", "--show-toplevel");
  const dir = mkdtempSync(join(tmpdir(), "scan-bench-"));
  const tree = join(dir, "tree");
  git("worktree", "add", "--detach", "--quiet", tree, ref);
  try {
    const script = join(tree, "web", "bench", "scan-bench.mjs");
    mkdirSync(dirname(script), { recursive: true });
    copyFileSync(here, script);
    return JSON.parse(execFileSync(process.execPath, [script], { cwd: tree, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
  } finally {
    try {
      execFileSync("git", ["-C", root, "worktree", "remove", "--force", tree], { stdio: "ignore" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// The head and base results, scenario by scenario.
function sideBySide(ref, head, base) {
  const names = [...new Set([...head.scenarios, ...base.scenarios].map((s) => s.name))];
  const pick = (doc, name) => {
    const s = doc.scenarios.find((x) => x.name === name);
    return s ? { api: s.api, archive: s.archive, fakeSeconds: s.fakeSeconds, result: s.result } : null;
  };
  return {
    base: ref,
    scenarios: names.map((name) => ({ name, head: pick(head, name), base: pick(base, name) })),
    unexpected: { head: head.unexpected, base: base.unexpected },
    wallMs: { head: head.wallMs, base: base.wallMs },
  };
}

async function main(argv) {
  const i = argv.indexOf("--base");
  const ref = i === -1 ? null : argv[i + 1];
  if (i !== -1 && !ref) throw new Error("usage: scan-bench.mjs [--base <git-ref>]");
  const head = await runScenarios();
  const doc = ref ? sideBySide(ref, head, runAtRef(ref)) : head;
  process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
  const bad = ref ? [...doc.unexpected.head, ...doc.unexpected.base] : doc.unexpected;
  if (bad.length) {
    process.stderr.write(`scan-bench: ${bad.length} unexpected request(s):\n${bad.join("\n")}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`scan-bench: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
}
