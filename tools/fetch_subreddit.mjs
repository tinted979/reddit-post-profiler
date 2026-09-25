// Fetch one subreddit's posts or comments made after a time, for the archive sync's splice
// builder (docs/adr/0005). It pages Arctic Shift's subreddit-wide search through the page's own
// ArcticShiftClient (web/core.js): one request at a time, a second apart, tagged
// meta-app=reddit-post-profiler-archive, with its backoff, and it stops rather than send
// anything more when the server is busy or rate-limiting (docs/adr/0002).
//
// Usage (Node 22+, from the repo root):
//
//   node tools/fetch_subreddit.mjs --subreddit Hasan_Piker --kind comments \
//       --after 1790000000 --budget 200 --out comments.jsonl --result comments.json
//
//   --after   epoch seconds, exclusive; leave it out to start from the subreddit's first row
//   --before  epoch seconds, exclusive; default a minute ago (SETTLE), and never later, so
//             what the search returns has had time to be archived
//   --budget  the most pages (requests, not counting retries) to fetch; 100 rows a page
//
// --out gets the rows as JSON lines, {id, author, created_utc, subreddit[, link_id]}, the shape
// build_dumps.py reads: exactly the rows after `after` up to `complete_through`, oldest first.
// --result gets {subreddit, kind, after, before, pages, requests, items, skipped, reached_end,
// complete_through, error, busy}:
//   complete_through  every row up to this second (inclusive) is in --out: the second before
//                     `before` when the fetch reached the end; otherwise the second before the
//                     newest row fetched (rows of that second may be missing), or `after` if
//                     none was
//   skipped           rows dropped as malformed (no id or time) or outside the window
//   error, busy       why an API error stopped it, and whether that was a busy or rate-limiting
//                     server, or no connection (then the sync should stop asking for now)
//
// Exit status: 0 when the fetch reached the end or its budget; 3 when an API error stopped it
// (both files are still written, with what it got); 2 for bad arguments (nothing written).

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs as parseCli } from "node:util";

import { ArcticShiftClient, ArcticShiftError, refusesMore } from "../web/core.js";

// The sync's own meta-app tag, so Arctic Shift can tell its load from the page's visitors.
export const ARCHIVE_TAG = "reddit-post-profiler-archive";
export const USER_AGENT = `${ARCHIVE_TAG} (+https://github.com/tinted979/reddit-post-profiler)`;
// Seconds a row is given to be archived before a fetch may call its second complete. Arctic
// Shift normally archives within a minute; the page allows an hour on top (INGEST_LAG), and
// the sync's overlap and weekly repair catch what comes later still.
export const SETTLE = 60;
// Seconds between request starts, one request in flight: slower than the page, since nobody
// is waiting.
const DELAY = 1;
// Rows per page: the search endpoint's largest `limit`, so a short page marks the end.
const PAGE = 100;
const MAX_BUDGET = 10_000;
const FIELDS = { posts: "id,author,created_utc", comments: "id,author,created_utc,link_id" };
const SUBREDDIT_NAME = /^\w{2,21}$/;
const EPOCH = /^\d{1,10}$/;
const ROW_ID = /^[0-9a-z]{1,13}$/;
const LINK_ID = /^(?:t3_)?[0-9a-z]{1,13}$/;

const USAGE = `usage: node tools/fetch_subreddit.mjs --subreddit NAME --kind posts|comments
       [--after EPOCH] [--before EPOCH] --budget PAGES --out ROWS.jsonl --result RESULT.json`;

// The command line, checked: throws an Error naming the first bad argument. `now` is epoch
// seconds.
export function parseArgs(argv, now) {
  const { values } = parseCli({
    args: argv,
    options: Object.fromEntries(
      ["subreddit", "kind", "after", "before", "budget", "out", "result"].map((name) => [name, { type: "string" }])
        .concat([["help", { type: "boolean", short: "h" }]]),
    ),
    strict: true,
    allowPositionals: false,
  });
  if (values.help) return { help: true };
  for (const name of ["subreddit", "kind", "budget", "out", "result"]) {
    if (!values[name]) throw new Error(`--${name} is required`);
  }
  if (!SUBREDDIT_NAME.test(values.subreddit)) throw new Error("--subreddit must be a subreddit name (2-21 letters, digits or _)");
  if (!(values.kind in FIELDS)) throw new Error("--kind must be posts or comments");
  const epoch = (name) => {
    if (values[name] === undefined) return null;
    if (!EPOCH.test(values[name])) throw new Error(`--${name} must be epoch seconds`);
    return Number(values[name]);
  };
  const latest = Math.floor(now) - SETTLE;
  const after = epoch("after");
  const before = epoch("before") ?? latest;
  if (before > latest) throw new Error(`--before must be at least ${SETTLE} s ago`);
  if (after !== null && after >= before) throw new Error("--after must be earlier than --before");
  const budget = /^\d+$/.test(values.budget) ? Number(values.budget) : NaN;
  if (!(budget >= 1 && budget <= MAX_BUDGET)) throw new Error(`--budget must be a number of pages from 1 to ${MAX_BUDGET}`);
  if (resolve(values.out) === resolve(values.result)) throw new Error("--out and --result must be different files");
  return { subreddit: values.subreddit, kind: values.kind, after, before, budget, out: values.out, result: values.result, help: false };
}

// The page's client, set up for the sync: one request at a time, DELAY apart, with the sync's
// tag and a User-Agent. `opts` passes through (the tests' clock); `fetchFn` is wrapped.
export function archiveClient({ fetchFn = (...a) => globalThis.fetch(...a), ...opts } = {}) {
  const withAgent = (url, init = {}) => fetchFn(url, { ...init, headers: { ...init.headers, "User-Agent": USER_AGENT } });
  return new ArcticShiftClient({ ...opts, delay: DELAY, maxInFlight: 1, appTag: ARCHIVE_TAG, fetchFn: withAgent });
}

// A row as the build reads it, from an API row, or null if it can't be used: search results
// are untrusted, so only known fields are copied, each checked.
function cleanRow(raw, { subreddit, kind, after, before }) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !ROW_ID.test(raw.id)) return null;
  const createdUtc = Math.trunc(Number(raw.created_utc));
  if (!Number.isFinite(createdUtc) || (after !== null && createdUtc <= after) || createdUtc >= before) return null;
  const row = { id: raw.id, author: typeof raw.author === "string" ? raw.author : null, created_utc: createdUtc, subreddit };
  if (kind === "comments") row.link_id = typeof raw.link_id === "string" && LINK_ID.test(raw.link_id) ? raw.link_id : null;
  return row;
}

// One subreddit and kind's rows after `after` (exclusive; null for the start) and before
// `before` (exclusive), at most `budget` pages. Returns {rows, result}, as described at the top.
// An API error stops it with what it had; anything else (a bug) throws.
export async function fetchSubreddit(client, { subreddit, kind, after = null, before, budget }) {
  const window = { subreddit, kind, after, before };
  const sent = client.requests;
  const fetched = [];
  let pages = 0;
  let skipped = 0;
  let newest = null;
  let reachedEnd = false;
  let error = null;
  let busy = false;
  const iter = client.iterAscending(`/api/${kind}/search`, { subreddit, after, before, fields: FIELDS[kind] }, PAGE, { maxPages: budget });
  try {
    let next;
    while (!(next = await iter.next()).done) {
      pages++;
      for (const raw of next.value) {
        const row = cleanRow(raw, window);
        if (!row) {
          skipped++;
          continue;
        }
        fetched.push(row);
        newest = Math.max(newest ?? row.created_utc, row.created_utc);
      }
    }
    reachedEnd = next.value === true;
  } catch (err) {
    if (!(err instanceof ArcticShiftError)) throw err;
    error = err.message;
    busy = refusesMore(err);
  }
  // A fetch cut short has only part of its newest row's second.
  const completeThrough = reachedEnd ? before - 1 : newest === null ? after : newest - 1;
  const rows = fetched
    .filter((row) => completeThrough !== null && row.created_utc <= completeThrough)
    .sort((a, b) => a.created_utc - b.created_utc || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const result = {
    ...window,
    pages,
    requests: client.requests - sent,
    items: rows.length,
    skipped,
    reached_end: reachedEnd,
    complete_through: completeThrough,
    error,
    busy,
  };
  return { rows, result };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const when = (t) => (t === null ? "the start" : new Date(t * 1000).toISOString().replace(".000Z", "Z"));

// The command: returns the exit status. `deps` swaps in the tests' fetch, clock and output.
export async function main(argv, { fetchFn, now = () => Date.now() / 1000, sleep, log = console.log, error = console.error } = {}) {
  let opts;
  try {
    opts = parseArgs(argv, now());
  } catch (err) {
    error(`fetch_subreddit: ${err.message}`);
    error(USAGE);
    return 2;
  }
  if (opts.help) {
    log(USAGE);
    return 0;
  }
  const client = archiveClient({
    fetchFn,
    // The tests' clock; otherwise the client's own.
    ...(sleep && { now, sleep }),
    onWait: (reason, seconds) => reason && log(`waiting ${Math.round(seconds)} s: ${reason}`),
  });
  const { rows, result } = await fetchSubreddit(client, opts);
  await writeFile(opts.out, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  await writeFile(opts.result, `${JSON.stringify(result, null, 2)}\n`);
  log(
    `r/${opts.subreddit}: ${result.items} ${opts.kind} complete through ${when(result.complete_through)} ` +
      `(${result.reached_end ? "reached the end" : result.error ? `stopped: ${result.error}` : "stopped at the budget"}); ` +
      `${plural(result.pages, "page")}, ${plural(result.requests, "request")}, ${plural(result.skipped, "row")} skipped`,
  );
  return result.error ? 3 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
