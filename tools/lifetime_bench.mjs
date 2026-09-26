// Benchmark for P8 of the archive plan (docs/history/2026-09-25-archive-sync.md): can one
// /api/users/interactions/subreddits query stand in for the two
// /api/{posts,comments}/search/aggregate queries a full scan asks first for each commenter?
// For each user it asks both, with the same bounds as a scan (every count stops at the post,
// docs/adr/0006), in alternating order so neither always goes first, and compares the answers.
//
// It calls the live Arctic Shift API, so the owner runs it; tests and agents never do. It uses
// the page's own client (pacing, backoff, meta-app=reddit-post-profiler), one request at a
// time and a second apart, and stops at the first busy or rate-limiting reply (docs/adr/0002).
//
// Usage (Node 22+, from the repo root):
//   node tools/lifetime_bench.mjs --post <reddit url or id> [--max 50] [--years N] [--out bench.json]
//   node tools/lifetime_bench.mjs --users name,name,... [--before EPOCH] [--years N] [--out bench.json]
//
//   --post   the post's commenters, most active first (2 requests to find them), counted up
//            to the post; --users, the names given, up to --before (default an hour ago)
//   --years  count only the N years before that, like the page's history window
//   --out    also save every answer and the summary as JSON
//
// About 3 requests per user: 50 users take about 3 minutes. It prints agreement (subreddit
// names compared without case), what differs for each user that disagrees, errors by kind,
// latency (interactions against the two aggregates together), retries, and the gate for
// switching (P8b): at least 99% agreement, no slower, and no more slow-downs.
//
// Exit status: 0 when it ran through; 3 when a busy or rate-limiting server stopped it (the
// results so far are still printed and saved); 2 for bad arguments.

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs as parseCli } from "node:util";

import {
  ArcticShiftClient, ArcticShiftError, QueryTimeout, ServerBusy, Unsupported, collectCommenters, parsePostRef, refusesMore,
} from "../web/core.js";

export const USER_AGENT = "reddit-post-profiler lifetime benchmark (+https://github.com/tinted979/reddit-post-profiler)";
const DELAY = 1;
const KINDS = ["posts", "comments"];
const DAY = 86400;
const USERNAME = /^[\w-]{3,20}$/;
// The gate for P8b.
const MIN_AGREEMENT = 0.99;
const USAGE = `usage: node tools/lifetime_bench.mjs --post <url or id> [--max 50] [--years N] [--out bench.json]
       node tools/lifetime_bench.mjs --users a,b,c [--before EPOCH] [--years N] [--out bench.json]`;

export function parseArgs(argv) {
  const { values } = parseCli({
    args: argv,
    options: {
      post: { type: "string" }, users: { type: "string" }, max: { type: "string" }, years: { type: "string" },
      before: { type: "string" }, out: { type: "string" }, help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) return { help: true };
  if (Boolean(values.post) === Boolean(values.users)) throw new Error("give --post or --users, not both");
  const whole = (name, lo, hi, fallback) => {
    if (values[name] === undefined) return fallback;
    const n = /^\d+$/.test(values[name]) ? Number(values[name]) : NaN;
    if (!(n >= lo && n <= hi)) throw new Error(`--${name} must be a whole number from ${lo} to ${hi}`);
    return n;
  };
  let users = null;
  if (values.users) {
    users = values.users.split(",").map((u) => u.trim()).filter(Boolean);
    const bad = users.find((u) => !USERNAME.test(u));
    if (bad !== undefined || !users.length) throw new Error(`--users takes Reddit usernames, comma-separated: ${bad ?? "none"}`);
  }
  return {
    post: values.post ? parsePostRef(values.post) : null,
    users,
    max: whole("max", 1, 1000, 50),
    years: whole("years", 1, 30, null),
    before: whole("before", 1, 9_999_999_999, null),
    out: values.out ?? null,
    help: false,
  };
}

// The page's client, set up for the benchmark: one request at a time, DELAY apart, with a
// User-Agent, timing each request's answer (ms, a clock in milliseconds) into
// `timings.list` while one is being collected.
export function benchClient({ fetchFn = (...a) => globalThis.fetch(...a), ms = () => performance.now(), ...opts } = {}) {
  const timings = { list: null };
  const timed = async (url, init = {}) => {
    const start = ms();
    try {
      return await fetchFn(url, { ...init, headers: { ...init.headers, "User-Agent": USER_AGENT } });
    } finally {
      timings.list?.push({ path: new URL(url).pathname, ms: ms() - start });
    }
  };
  return { client: new ArcticShiftClient({ ...opts, delay: DELAY, maxInFlight: 1, fetchFn: timed }), timings };
}

// Map<subreddit, {posts, comments}> keyed by lowercase name, without empty counts.
function normalize(counts) {
  const out = new Map();
  for (const [sub, c] of counts) {
    const key = sub.toLowerCase();
    const o = out.get(key) ?? { posts: 0, comments: 0 };
    o.posts += c.posts;
    o.comments += c.comments;
    out.set(key, o);
  }
  for (const [key, c] of out) if (!c.posts && !c.comments) out.delete(key);
  return out;
}

// Whether the aggregates' and interactions' counts agree, and each subreddit where they don't.
export function compareCounts(aggregates, interactions) {
  const a = normalize(aggregates);
  const i = normalize(interactions);
  const diffs = [];
  for (const sub of [...new Set([...a.keys(), ...i.keys()])].sort()) {
    const x = a.get(sub) ?? { posts: 0, comments: 0 };
    const y = i.get(sub) ?? { posts: 0, comments: 0 };
    if (x.posts !== y.posts || x.comments !== y.comments) diffs.push({ subreddit: sub, aggregates: x, interactions: y });
  }
  return { agree: diffs.length === 0, diffs };
}

// What went wrong with a request, as a short word; anything that isn't an API error is a bug.
function errorKind(err) {
  if (err instanceof QueryTimeout) return "timeout";
  if (err instanceof Unsupported) return "unsupported";
  if (err instanceof ServerBusy) return "busy";
  if (err instanceof ArcticShiftError) return err.status === 429 ? "rate limited" : err.status === null ? "network" : `HTTP ${err.status}`;
  throw err;
}

const retriesOf = (client) => [...client.retries.values()].reduce((a, b) => a + b, 0);
const sum = (list) => list.reduce((a, t) => a + t.ms, 0);

// One call, timed and with its retries counted: {value | error, ms (each request's time), retries}.
async function measure(bench, call) {
  bench.timings.list = [];
  const retries = retriesOf(bench.client);
  const result = { error: null, value: null, refused: false };
  try {
    result.value = await call();
  } catch (err) {
    result.error = errorKind(err);
    result.refused = refusesMore(err);
  }
  result.timings = bench.timings.list;
  result.retries = retriesOf(bench.client) - retries;
  bench.timings.list = null;
  return result;
}

async function askAggregates(bench, user, bounds) {
  const r = await measure(bench, async () => {
    // As a scan asks first (core.js lifetimeCounts): a timed-out aggregate once more, no split.
    const settled = await Promise.allSettled(KINDS.map((kind) =>
      bench.client.subredditCounts(kind, user, { ...bounds, split: false })));
    // A busy or rate-limiting reply wins over the other's timeout, so the run stops.
    const rejected = settled.filter((s) => s.status === "rejected").map((s) => s.reason);
    const failed = rejected.find((err) => err instanceof ArcticShiftError && refusesMore(err)) ?? rejected[0];
    if (failed) throw failed;
    const counts = new Map();
    for (const [i, kind] of KINDS.entries()) {
      for (const [sub, n] of settled[i].value) {
        const c = counts.get(sub) ?? { posts: 0, comments: 0 };
        c[kind] += n;
        counts.set(sub, c);
      }
    }
    return counts;
  });
  const ms = Object.fromEntries(KINDS.map((kind) => [kind, sum(r.timings.filter((t) => t.path.includes(`/${kind}/`)))]));
  return { ms, error: r.error, subreddits: r.value?.size ?? null, retries: r.retries, counts: r.value, refused: r.refused };
}

async function askInteractions(bench, user, bounds) {
  const r = await measure(bench, () => bench.client.interactionCounts(user, bounds));
  return { ms: sum(r.timings), error: r.error, subreddits: r.value?.size ?? null, retries: r.retries, counts: r.value, refused: r.refused };
}

// Both answers for each user in turn (aggregates first for every other user), until a busy or
// rate-limiting reply, after which nothing more is sent. Returns {records, stopped}: `stopped`
// says why it ended early, or is null.
export async function runBench(bench, users, { after = null, before }) {
  const bounds = { after, before };
  const records = [];
  for (const [n, user] of users.entries()) {
    const order = n % 2 === 0 ? ["aggregates", "interactions"] : ["interactions", "aggregates"];
    const record = { user, order: `${order[0]} first`, aggregates: null, interactions: null, agree: null, diffs: [] };
    records.push(record);
    for (const which of order) {
      const answer = which === "aggregates" ? await askAggregates(bench, user, bounds) : await askInteractions(bench, user, bounds);
      record[which] = answer;
      if (answer.refused) {
        for (const r of [record.aggregates, record.interactions]) if (r) delete r.counts;
        return { records: records.map(clean), stopped: `Arctic Shift was ${answer.error} at ${user}, so the run stopped there` };
      }
    }
    if (record.aggregates.counts && record.interactions.counts) {
      Object.assign(record, compareCounts(record.aggregates.counts, record.interactions.counts));
    }
  }
  return { records: records.map(clean), stopped: null };
}

// A record as saved: the counts themselves are left out (only how many subreddits).
function clean(record) {
  const strip = (r) => (r ? { ms: r.ms, error: r.error, subreddits: r.subreddits, retries: r.retries } : null);
  return { ...record, aggregates: strip(record.aggregates), interactions: strip(record.interactions) };
}

function spread(values) {
  if (!values.length) return { median: null, p90: null };
  const s = [...values].sort((a, b) => a - b);
  const rank = (q) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
  return { median: rank(0.5), p90: rank(0.9) };
}

// The numbers for the report, and the gate's verdict.
export function summarize(records) {
  const both = records.filter((r) => r.agree !== null);
  const agree = both.filter((r) => r.agree).length;
  const errors = { aggregates: {}, interactions: {} };
  for (const r of records) {
    for (const which of ["aggregates", "interactions"]) {
      const e = r[which]?.error;
      if (e) errors[which][e] = (errors[which][e] ?? 0) + 1;
    }
  }
  // Over the same users on both sides, those where both answered: the users only
  // interactions answered for (their aggregates timed out) are the slowest, and would count
  // against it.
  const latency = {
    interactions: spread(both.map((r) => r.interactions.ms)),
    aggregatesTogether: spread(both.map((r) => r.aggregates.ms.posts + r.aggregates.ms.comments)),
    aggregatesSlowest: spread(both.map((r) => Math.max(r.aggregates.ms.posts, r.aggregates.ms.comments))),
  };
  const retries = {
    aggregates: records.reduce((a, r) => a + (r.aggregates?.retries ?? 0), 0),
    interactions: records.reduce((a, r) => a + (r.interactions?.retries ?? 0), 0),
  };
  const agreement = both.length ? agree / both.length : null;
  const i = latency.interactions;
  const g = latency.aggregatesTogether;
  const gate = {
    agreement: agreement !== null && agreement >= MIN_AGREEMENT,
    speed: i.median !== null && g.median !== null && i.median <= g.median && i.p90 <= g.p90,
    slowdowns: retries.interactions <= retries.aggregates,
  };
  gate.pass = gate.agreement && gate.speed && gate.slowdowns;
  return {
    users: records.length,
    bothAnswered: both.length,
    agree,
    agreement,
    errors,
    interactionsWhereAggregatesTimedOut: records.filter((r) => r.aggregates?.error === "timeout" && r.interactions && !r.interactions.error).length,
    latency,
    retries,
    gate,
  };
}

const pct = (x) => (x === null ? "-" : `${(100 * x).toFixed(1)}%`);
const ms = (s) => (s.median === null ? "-" : `median ${Math.round(s.median)} ms, p90 ${Math.round(s.p90)} ms`);
const kinds = (e) => Object.entries(e).map(([k, n]) => `${k} ${n}`).join(", ") || "none";

function report(records, summary, stopped, log) {
  log(`agree: ${summary.agree} of ${summary.bothAnswered} users where both answered (${pct(summary.agreement)}), of ${summary.users} tried`);
  for (const r of records.filter((x) => x.agree === false)) {
    const shown = r.diffs.slice(0, 5).map((d) =>
      `r/${d.subreddit} ${d.aggregates.posts}p/${d.aggregates.comments}c vs ${d.interactions.posts}p/${d.interactions.comments}c`);
    log(`  u/${r.user}: aggregates vs interactions: ${shown.join("; ")}${r.diffs.length > 5 ? ` (and ${r.diffs.length - 5} more)` : ""}`);
  }
  log(`errors: aggregates ${kinds(summary.errors.aggregates)}; interactions ${kinds(summary.errors.interactions)}`);
  log(`interactions answered where the aggregates timed out: ${summary.interactionsWhereAggregatesTimedOut}`);
  log(`latency, for the users where both answered: interactions ${ms(summary.latency.interactions)}; the two aggregates together ${ms(summary.latency.aggregatesTogether)}` +
    ` (the slower of them ${ms(summary.latency.aggregatesSlowest)})`);
  log(`retries: aggregates ${summary.retries.aggregates}, interactions ${summary.retries.interactions}`);
  const g = summary.gate;
  log(`gate: agreement >= ${pct(MIN_AGREEMENT)} ${g.agreement ? "yes" : "no"}; no slower ${g.speed ? "yes" : "no"};` +
    ` no more retries ${g.slowdowns ? "yes" : "no"}: ${g.pass ? "PASS" : "not passed"}`);
  if (stopped) log(`stopped early: ${stopped}`);
}

// The command: returns the exit status. `deps` swaps in the tests' fetch, clocks and output.
export async function main(argv, { fetchFn, now, sleep, ms: msClock, log = console.log, error = console.error } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    error(`lifetime_bench: ${err.message}`);
    error(USAGE);
    return 2;
  }
  if (opts.help) {
    log(USAGE);
    return 0;
  }
  const bench = benchClient({ fetchFn, ...(msClock && { ms: msClock }), ...(sleep && { now, sleep }) });
  let users = opts.users;
  let before = opts.before ?? Math.floor(Date.now() / 1000) - 3600;
  if (opts.post) {
    const post = await bench.client.getPost(opts.post);
    if (!post) {
      error(`lifetime_bench: no post ${opts.post} in the archive`);
      return 2;
    }
    before = opts.before ?? post.createdUtc;
    const commenters = await collectCommenters(bench.client, post);
    users = [...commenters].sort((a, b) => b[1].count - a[1].count).slice(0, opts.max).map(([name]) => name);
    log(`r/${post.subreddit} post ${post.id}: ${users.length} of ${commenters.size} commenters, counted up to the post`);
  }
  const after = opts.years ? Math.floor(before - opts.years * 365.25 * DAY) : null;
  const { records, stopped } = await runBench(bench, users, { after, before });
  const summary = summarize(records);
  report(records, summary, stopped, log);
  if (opts.out) {
    await writeFile(opts.out, `${JSON.stringify({ post: opts.post, before, after, records, summary, stopped }, null, 2)}\n`);
  }
  return stopped ? 3 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
