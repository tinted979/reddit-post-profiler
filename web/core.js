// Arctic Shift client and the profiling logic behind the web app: finding a thread's
// commenters, building each one's per-subreddit profile, and the CSV export (the same
// columns as the Python CLI in src/reddit_tool). No DOM access here, so it runs under Node
// for the tests.

export const BASE_URL = "https://arctic-shift.photon-reddit.com";
// The first year of Reddit data: where the yearly split starts.
const ARCHIVE_START_YEAR = 2005;
// Authors that can't be profiled: deleted accounts, and the moderation bot.
const DEFAULT_EXCLUDED = new Set(["[deleted]", "[removed]", "automoderator"]);
// The interactions endpoint returns posts * weight_posts + comments * weight_comments per
// subreddit, so a large post weight packs both counts into one number. That assumes
// fewer than a million comments in any one subreddit.
const POST_WEIGHT = 1_000_000;
// Most comments /api/comments/tree returns in one response.
const TREE_LIMIT = 25_000;
// Arctic Shift normally archives new posts and comments within a minute. Allow an hour
// for backlogs before trusting that counts fetched at some moment include everything
// made before it.
const INGEST_LAG = 3600;
// Prefix of every cache key; change it when the stored format changes.
const CACHE_VERSION = "v1";

export class ArcticShiftError extends Error {
  // `status` is the HTTP status, or null when the request never got a response.
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}
// The query is too heavy for the server (a very active user), so split it up.
export class QueryTimeout extends ArcticShiftError {}
// The server kept asking us to slow down. It's overloaded, so give up on this request
// rather than falling back to more (and heavier) queries.
export class ServerBusy extends ArcticShiftError {}
// The interactions endpoint can't answer for this user: too much data, an error, or an
// answer we can't decode.
export class Unsupported extends ArcticShiftError {}
// The run was stopped.
export class Aborted extends Error {}

const ID = "[0-9a-z]{1,13}";
const URL_PATTERNS = [
  new RegExp(`/comments/(${ID})(?:[/?#]|$)`, "i"),
  new RegExp(`redd\\.it/(${ID})(?:[/?#]|$)`, "i"),
];
const BARE_ID = new RegExp(`^(?:t3_)?(${ID})$`, "i");

export function parsePostRef(ref) {
  ref = String(ref).trim();
  for (const pattern of URL_PATTERNS) {
    const m = ref.match(pattern);
    if (m) return m[1].toLowerCase();
  }
  const m = ref.match(BARE_ID);
  if (m) return m[1].toLowerCase();
  if (/\/s\/\w+/.test(ref)) {
    throw new Error(
      "Reddit app share links (…/s/…) don't include the post id. Open the link in a " +
        "browser and paste the address it leads to.",
    );
  }
  throw new Error(
    "Can't find a post id in that input. Paste a Reddit post URL " +
      "(…/comments/<id>/…), a redd.it link, or the post id.",
  );
}

// Resolves after `seconds`, or as soon as `signal` aborts.
function wait(seconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, seconds * 1000);
    signal?.addEventListener("abort", done);
  });
}

// Seconds on a clock that doesn't jump if the system time is changed mid-run.
const monotonicNow = () => (performance.timeOrigin + performance.now()) / 1000;

export class ArcticShiftClient {
  constructor({
    delay = 2.0,
    maxInFlight = 3,
    maxRetries = 4,
    maxRateLimitWaits = 10,
    baseUrl = BASE_URL,
    fetchFn = (...a) => globalThis.fetch(...a),
    sleep = wait,
    now = monotonicNow,
    signal = null,
    onWait = () => {},
    onPause = () => {},
  } = {}) {
    Object.assign(this, { delay, maxInFlight, maxRetries, maxRateLimitWaits, baseUrl, signal, onWait, onPause });
    this._fetch = fetchFn;
    this._sleepFn = sleep;
    this._now = now;
    // Request starts are spaced `delay` apart. A 429 or a network error pushes
    // `_pausedUntil` forward for every caller sharing this client.
    this._nextSlot = 0;
    this._pausedUntil = 0;
    this._pauseReason = null;
    // The server struggles with several heavy queries at once (it answers "slow down"),
    // so cap how many are in flight: halve the cap on a slow-down, 429 or network error,
    // and raise it one step after every 10 successes in a row.
    this._limit = Math.max(1, maxInFlight);
    this._inFlight = 0;
    this._waiters = [];
    this._streak = 0;
    // Requests actually sent, for the status line.
    this.requests = 0;
    // On Stop, release everything queued for a slot so it can see the abort.
    signal?.addEventListener("abort", () => {
      const waiters = this._waiters;
      this._waiters = [];
      for (const wake of waiters) wake();
    });
  }

  _checkAbort() {
    if (this.signal?.aborted) throw new Aborted("stopped");
  }

  async _sleep(seconds, reason) {
    this._checkAbort();
    if (reason) this.onWait(reason, seconds);
    try {
      await this._sleepFn(seconds, this.signal);
    } finally {
      if (reason) this.onWait(null, 0);
    }
    this._checkAbort();
  }

  // Reserve the next start slot synchronously, so concurrent callers can't grab the
  // same one, then wait for it. Re-check afterwards in case a pause began meanwhile.
  async _throttle() {
    for (;;) {
      const now = this._now();
      const start = Math.max(now, this._nextSlot, this._pausedUntil);
      this._nextSlot = start + this.delay;
      if (start <= now) return;
      await this._sleep(start - now, this._pausedUntil > now ? this._pauseReason : null);
      if (this._pausedUntil <= this._now()) return;
    }
  }

  async _acquire() {
    for (;;) {
      this._checkAbort();
      if (this._inFlight < this._limit) break;
      await new Promise((resolve) => this._waiters.push(resolve));
    }
    this._inFlight++;
  }

  _release() {
    this._inFlight--;
    this._wake();
  }

  _wake() {
    for (let free = this._limit - this._inFlight; free > 0 && this._waiters.length; free--) {
      this._waiters.shift()();
    }
  }

  // Pause every request on this client for `seconds`.
  _pause(seconds, reason) {
    const until = this._now() + seconds;
    if (until > this._pausedUntil) {
      this._pausedUntil = until;
      this._pauseReason = reason;
      this.onPause(until);
    }
  }

  _congested() {
    this._limit = Math.max(1, Math.floor(this._limit / 2));
    this._streak = 0;
  }

  _succeeded() {
    if (++this._streak >= 10 && this._limit < this.maxInFlight) {
      this._limit++;
      this._streak = 0;
      this._wake();
    }
  }

  // One attempt: wait for a slot and a start time, fetch and parse. Returns {resp,
  // payload} (payload is null when the body isn't JSON); throws the fetch error on a
  // network failure, and Aborted once stopped.
  async _attempt(url) {
    for (;;) {
      await this._acquire();
      try {
        await this._throttle();
      } catch (err) {
        this._release();
        throw err;
      }
      // The cap may have been lowered while this request waited for its start.
      if (this._inFlight <= this._limit) break;
      this._release();
    }
    try {
      this.requests++;
      const resp = await this._fetch(url, { signal: this.signal ?? undefined });
      let payload = null;
      try {
        payload = await resp.json();
      } catch {
        this._checkAbort();
      }
      return { resp, payload };
    } finally {
      this._release();
    }
  }

  // GET `path` and return the payload's `data`. Network errors, 5xx and garbled replies
  // are retried; a 429 or a network error pauses every request, a "slow down" answer only
  // this one, and each of those lowers the in-flight cap. Throws QueryTimeout when the
  // query is too heavy, ServerBusy when the server stays overloaded, ArcticShiftError
  // (with `status`) for anything else, and Aborted once stopped.
  async _get(path, params) {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    let failures = 0;
    let slowdowns = 0;
    let rateLimitWaits = 0;
    for (;;) {
      this._checkAbort();
      let resp;
      let payload;
      try {
        ({ resp, payload } = await this._attempt(url.toString()));
      } catch (err) {
        this._checkAbort();
        // Browsers surface CORS-less error responses (e.g. some 429s) as network
        // errors, so back off generously.
        if (++failures > this.maxRetries) {
          throw new ArcticShiftError(`network error on ${path}: ${err.message ?? err}`);
        }
        this._congested();
        this._pause(5 * 2 ** (failures - 1), "network error, retrying");
        continue;
      }

      if (resp.status === 429) {
        if (++rateLimitWaits > this.maxRateLimitWaits) {
          throw new ArcticShiftError(`still rate limited on ${path}, giving up`, 429);
        }
        // The reset header (seconds) is readable outside browsers only: the API doesn't
        // expose it via CORS, so browsers wait 30 s.
        const reset = Number(resp.headers.get("X-RateLimit-Reset"));
        this._congested();
        this._pause(Number.isFinite(reset) && reset > 0 ? reset + 1 : 30, "rate limited");
        continue;
      }

      const error = payload && typeof payload === "object" && payload.error ? String(payload.error) : null;
      if (error && /timed out/i.test(error)) throw new QueryTimeout(error, resp.status);
      if (error && /slow down/i.test(error)) {
        // Undocumented: under load the server answers 422 "Timeout. Maybe slow down
        // a bit"; the same query usually succeeds after a pause. Only this request
        // waits; the lower in-flight cap is what eases the load.
        if (++slowdowns > this.maxRetries) throw new ServerBusy(`server busy: ${error}`, resp.status);
        this._congested();
        await this._sleep(2 * 2 ** (slowdowns - 1), "server busy");
        continue;
      }
      if (resp.status >= 500 || (resp.ok && (payload === null || typeof payload !== "object"))) {
        if (++failures > this.maxRetries) {
          throw new ArcticShiftError(`HTTP ${resp.status} on ${path}: ${error ?? "bad response"}`, resp.status);
        }
        await this._sleep(2 ** failures, "server error, retrying");
        continue;
      }
      if (!resp.ok || error) {
        throw new ArcticShiftError(`HTTP ${resp.status} on ${path}: ${error ?? "error"}`, resp.status);
      }
      this._succeeded();
      return payload.data;
    }
  }

  async getPost(postId) {
    const data = await this._get("/api/posts/ids", {
      ids: postId,
      fields: "id,author,subreddit,created_utc,title,num_comments",
    });
    const p = Array.isArray(data) ? data[0] : null;
    if (!p?.subreddit) return null;
    return {
      id: p.id,
      author: p.author || "[deleted]",
      subreddit: p.subreddit,
      createdUtc: Math.trunc(Number(p.created_utc)),
      title: p.title || "",
      // Reddit's count when archived, deleted comments included.
      numComments: Number(p.num_comments) || 0,
    };
  }

  // Every archived comment under a post, in one request, from the comment tree. Returns
  // null when the tree can't be trusted to be complete (collapsed "more" stubs, an
  // unexpected shape, the size limit reached, nothing returned, or an API error), so the
  // caller pages instead.
  async threadCommentsTree(postId, limit = TREE_LIMIT) {
    let data;
    try {
      data = await this._get("/api/comments/tree", { link_id: postId, limit });
    } catch (err) {
      if (err instanceof ArcticShiftError) return null;
      throw err;
    }
    const seen = new Set();
    const out = [];
    // An explicit stack rather than recursion: reply chains can be thousands deep.
    const stack = [Array.isArray(data) ? data : []];
    while (stack.length) {
      for (const node of stack.pop()) {
        if (node?.kind === "more") return null;
        if (node?.kind !== "t1") continue;
        const d = node.data ?? {};
        if (d.id && !seen.has(d.id)) {
          seen.add(d.id);
          out.push({ id: d.id, author: d.author, created_utc: d.created_utc });
        }
        if (d.replies === "" || d.replies == null) continue;
        const children = d.replies.data?.children;
        if (!Array.isArray(children)) return null;
        stack.push(children);
      }
    }
    return out.length > 0 && out.length < limit ? out : null;
  }

  // Every archived comment under a post. The search endpoint has no cursor, so page on
  // created_utc: start the next page one second before the last one ended (comments can
  // share a second) and dedupe by id. With pageSize "auto" the server picks the page
  // size, so only an empty page, or two in a row with nothing new, marks the end.
  async *iterThreadComments(postId, pageSize = "auto") {
    const seen = new Set();
    let cursor = null;
    let stale = 0;
    for (;;) {
      const params = { link_id: postId, limit: pageSize, sort: "asc", fields: "id,author,created_utc" };
      if (cursor !== null) params.after = cursor;
      const page = await this._get("/api/comments/search", params);
      if (!Array.isArray(page) || !page.length) return;
      let fresh = 0;
      for (const c of page) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        fresh++;
        yield c;
      }
      if (typeof pageSize === "number" && page.length < pageSize) return;
      stale = fresh ? 0 : stale + 1;
      if (stale >= 2) return;
      const lastTs = Math.trunc(Number(page[page.length - 1].created_utc));
      // A page with nothing new is stuck on one second: step past it.
      let next = fresh ? lastTs - 1 : lastTs + 1;
      if (cursor !== null && next <= cursor) next = cursor + 1;
      cursor = next;
    }
  }

  // Map of subreddit -> {posts, comments} from one interactions query. `after`/`before`
  // bound the time window (epoch seconds). Throws Unsupported when the endpoint refuses or
  // fails for this user, or its counts can't be decoded; QueryTimeout, ServerBusy,
  // rate-limit and network errors pass through.
  async interactionCounts(author, { after = null, before = null } = {}) {
    const params = { author, limit: "", weight_posts: POST_WEIGHT, weight_comments: 1 };
    if (after !== null) params.after = after;
    if (before !== null) params.before = before;
    let data;
    try {
      data = await this._get("/api/users/interactions/subreddits", params);
    } catch (err) {
      const refused = err instanceof ArcticShiftError && !(err instanceof QueryTimeout || err instanceof ServerBusy) &&
        err.status !== null && err.status !== 429;
      throw refused ? new Unsupported(err.message, err.status) : err;
    }
    const counts = new Map();
    for (const row of Array.isArray(data) ? data : []) {
      const n = Number(row?.count);
      if (!Number.isSafeInteger(n) || n < 0) throw new Unsupported(`can't decode count ${row?.count}`);
      if (typeof row.subreddit !== "string") continue;
      const c = counts.get(row.subreddit) ?? { posts: 0, comments: 0 };
      c.posts += Math.floor(n / POST_WEIGHT);
      c.comments += n % POST_WEIGHT;
      counts.set(row.subreddit, c);
    }
    return counts;
  }

  // Map of subreddit -> count for `kind` ("posts" | "comments"), optionally for one
  // `subreddit`, within `after`/`before` (epoch seconds). A query that times out is sent
  // up to `attempts` times in all. Then, unless `split` is false (throw QueryTimeout
  // instead), it's split up: one query per subreddit in `only` when given (all we need,
  // and far cheaper for very active users), else one per year.
  async subredditCounts(kind, author, { subreddit = null, after = null, before = null, only = null, attempts = 2, split = true } = {}) {
    for (let i = 0; i < attempts; i++) {
      try {
        return await this._aggregate(kind, author, { subreddit, after, before });
      } catch (err) {
        if (!(err instanceof QueryTimeout) || (!split && i === attempts - 1)) throw err;
      }
    }
    const parts = only?.length && subreddit === null
      ? only.map((sub) => this.subredditCounts(kind, author, { subreddit: sub, after, before }))
      : yearlyRanges(before, this._now(), after).map(([start, end]) =>
        this._aggregate(kind, author, { subreddit, after: start, before: end }));
    const total = new Map();
    for (const part of await settleAll(parts)) {
      for (const [k, n] of part) total.set(k, (total.get(k) || 0) + n);
    }
    return total;
  }

  async _aggregate(kind, author, { subreddit = null, after = null, before = null } = {}) {
    // An empty limit returns every subreddit rather than the top few.
    const params = { aggregate: "subreddit", author, limit: "" };
    if (subreddit !== null) params.subreddit = subreddit;
    if (after !== null) params.after = after;
    if (before !== null) params.before = before;
    const data = await this._get(`/api/${kind}/search/aggregate`, params);
    const counts = new Map();
    for (const row of Array.isArray(data) ? data : []) {
      const n = Number(row?.count);
      if (typeof row?.key !== "string" || !Number.isFinite(n) || n < 0) continue;
      counts.set(row.key, (counts.get(row.key) || 0) + n);
    }
    return counts;
  }
}

// [start, end) epoch-second ranges covering each calendar year (UTC) from the start of
// the archive, or from `after`, up to `before` (default: now).
export function yearlyRanges(before, nowSeconds, after = null) {
  const endTs = before ?? Math.trunc(nowSeconds) + 1;
  const endYear = new Date(endTs * 1000).getUTCFullYear();
  const ranges = [];
  for (let year = ARCHIVE_START_YEAR; year <= endYear; year++) {
    const start = Math.max(Date.UTC(year, 0, 1) / 1000, after ?? 0);
    const stop = Math.min(Date.UTC(year + 1, 0, 1) / 1000, endTs);
    if (start < stop) ranges.push([start, stop]);
  }
  return ranges;
}

// The thread's commenters: Map of author -> {count, last}, their comments in the thread
// and when they made the newest one (epoch seconds). Deleted accounts, AutoModerator and
// `exclude` are left out; with `includeOp` the post's author is added with no comments.
export async function collectCommenters(client, post, { exclude = [], includeOp = false } = {}) {
  const excluded = new Set(DEFAULT_EXCLUDED);
  for (const name of exclude) excluded.add(name.toLowerCase().replace(/^\/?u\//, ""));
  // A thread too big for one tree response would be downloaded and then thrown away.
  const tree = post.numComments >= TREE_LIMIT ? null : await client.threadCommentsTree(post.id);
  const commenters = new Map();
  for await (const c of tree ?? client.iterThreadComments(post.id)) {
    const author = c.author;
    if (typeof author !== "string" || !author || excluded.has(author.toLowerCase())) continue;
    const at = Math.trunc(Number(c.created_utc)) || 0;
    const entry = commenters.get(author);
    if (entry) {
      entry.count++;
      entry.last = Math.max(entry.last, at);
    } else {
      commenters.set(author, { count: 1, last: at });
    }
  }
  if (includeOp && !excluded.has(post.author.toLowerCase()) && !commenters.has(post.author)) {
    commenters.set(post.author, { count: 0, last: null });
  }
  return commenters;
}

// Normalise subreddit names ("r/Foo", "/r/foo/", "reddit.com/r/Foo/…", "Foo") to bare
// names, dropping duplicates (ignoring case) and anything that can't be a subreddit.
export function parseSubreddits(names) {
  const seen = new Set();
  const out = [];
  for (const raw of names) {
    const name = String(raw)
      .trim()
      .replace(/^(?:https?:\/\/)?(?:[\w-]+\.)*reddit\.com/i, "")
      .replace(/^\/?r\//i, "")
      .replace(/\/.*$/, "");
    if (/^\w{2,21}$/.test(name) && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push(name);
    }
  }
  return out;
}

const KINDS = ["posts", "comments"];

// Like Promise.all, but waits for every promise to settle before rethrowing the first
// failure, so no request is left running once the caller moves on.
async function settleAll(promises) {
  const results = await Promise.allSettled(promises);
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
  return results.map((r) => r.value);
}

// Lifetime counts as Map<subreddit, {posts, comments}> (since `after`, when given). The
// per-kind aggregates are the quickest answer for most users. When one times out (a very
// active user), a single interactions query usually still answers; failing that, only
// the kind that timed out is split up (per subreddit in `wanted`, else per year).
// `partial` marks a result limited to `wanted`, which mustn't be saved as a profile.
async function lifetimeCounts(client, username, { wanted, after }) {
  const first = await Promise.allSettled(
    KINDS.map((kind) => client.subredditCounts(kind, username, { after, split: false })),
  );
  for (const r of first) {
    if (r.status === "rejected" && !(r.reason instanceof QueryTimeout)) throw r.reason;
  }
  const done = (i) => first[i].status === "fulfilled";
  if (done(0) && done(1)) return { counts: mergeKinds(first.map((r) => r.value)), partial: false };
  try {
    return { counts: await client.interactionCounts(username, { after }), partial: false };
  } catch (err) {
    if (!(err instanceof QueryTimeout || err instanceof Unsupported)) throw err;
  }
  const parts = await settleAll(KINDS.map((kind, i) =>
    done(i) ? first[i].value : client.subredditCounts(kind, username, { after, only: wanted, attempts: 0 })));
  return { counts: mergeKinds(parts), partial: Boolean(wanted) };
}

// [posts map, comments map] -> Map<subreddit, {posts, comments}>
function mergeKinds(parts) {
  const counts = new Map();
  for (const [i, kind] of KINDS.entries()) {
    for (const [sub, n] of parts[i]) {
      const c = counts.get(sub) ?? { posts: 0, comments: 0 };
      c[kind] += n;
      counts.set(sub, c);
    }
  }
  return counts;
}

// Posts and comments in the post's subreddit before it was made, within the window.
// Only the kinds the lifetime totals don't already rule out are queried.
async function beforeCounts(client, username, post, { after, needPosts, needComments }) {
  const opts = { subreddit: post.subreddit, after, before: post.createdUtc };
  const [posts, comments] = await settleAll([
    needPosts ? client.subredditCounts("posts", username, opts) : null,
    needComments ? client.subredditCounts("comments", username, opts) : null,
  ]);
  return { posts: posts ? sum(posts) : 0, comments: comments ? sum(comments) : 0 };
}

const isCount = (n) => Number.isFinite(n) && n >= 0;
// [[subreddit, posts, comments], …]
const isRows = (v) =>
  Array.isArray(v) && v.every((r) => Array.isArray(r) && typeof r[0] === "string" && isCount(r[1]) && isCount(r[2]));
// {posts, comments}
const isBefore = (v) => v !== null && typeof v === "object" && isCount(v.posts) && isCount(v.comments);

// A saved record ({value, fetchedAt}) if there is one and its value passes `valid`; a
// broken or old-format record counts as missing.
async function cacheGet(cache, key, valid) {
  try {
    const rec = await cache?.get(key);
    return rec && Number.isFinite(rec.fetchedAt) && valid(rec.value) ? rec : null;
  } catch {
    return null;
  }
}

async function cacheSet(cache, key, value) {
  try {
    await cache?.set(key, value);
  } catch {
    // Saving is best-effort.
  }
}

// Build a user's profile. `threadComments` is their comment count in the thread and
// `lastCommentUtc` when they made the newest one (null if unknown). With `only`, the
// profile lists just those subreddits (plus the post's own), including ones with no
// activity so the answer is explicit. With `after` (epoch seconds), only activity from
// then on is counted, "before the post" included. With `cache` ({get(key) -> {value,
// fetchedAt} | null, set(key, value)}), earlier results are reused and new ones saved.
export async function buildProfile(client, username, threadComments, post, { only = null, after = null, lastCommentUtc = null, cache = null } = {}) {
  const profile = {
    username,
    threadComments,
    targetPostsBefore: 0,
    targetCommentsBefore: 0,
    subreddits: new Map(), // display name -> {posts, comments}
    error: null,
    cached: false,
  };
  const user = username.toLowerCase();
  // Round the window start to the day so cache keys stay stable between runs.
  const bucket = after === null ? "all" : String(Math.floor(after / 86400));
  const wanted = only?.length ? parseSubreddits([post.subreddit, ...only]) : null;

  const lifeKey = `${CACHE_VERSION}|life|${user}|${bucket}`;
  const hit = await cacheGet(cache, lifeKey, isRows);
  let rows;
  if (hit) {
    rows = hit.value;
  } else {
    const life = await lifetimeCounts(client, username, { wanted, after });
    rows = [...life.counts].map(([sub, c]) => [sub, c.posts, c.comments]);
    if (!life.partial) await cacheSet(cache, lifeKey, rows);
  }

  const byKey = new Map();
  for (const [sub, posts, comments] of rows) {
    // Merge case-insensitively, keeping the first spelling we saw.
    let counts = byKey.get(sub.toLowerCase());
    if (!counts) {
      counts = { posts: 0, comments: 0 };
      byKey.set(sub.toLowerCase(), counts);
      profile.subreddits.set(sub, counts);
    }
    counts.posts += posts;
    counts.comments += comments;
  }

  if (wanted) {
    const keep = new Set(wanted.map((s) => s.toLowerCase()));
    for (const name of [...profile.subreddits.keys()]) {
      if (!keep.has(name.toLowerCase())) profile.subreddits.delete(name);
    }
    for (const name of wanted) {
      if (!byKey.has(name.toLowerCase())) {
        const counts = { posts: 0, comments: 0 };
        byKey.set(name.toLowerCase(), counts);
        profile.subreddits.set(name, counts);
      }
    }
  }

  // Only ask for "before the post" counts when the lifetime totals leave room for any:
  // the OP's own post and every comment in the thread came after the post was made.
  // That holds only if the totals include the post and all of this user's comments in
  // the thread: true for totals fetched just now (the thread came from the same
  // archive), and for saved ones fetched well after their last comment here.
  // A post older than the window has no "before" inside it at all.
  const target = byKey.get(post.subreddit.toLowerCase()) ?? { posts: 0, comments: 0 };
  const isOp = user === post.author.toLowerCase();
  const last = Math.max(post.createdUtc, lastCommentUtc ?? (threadComments > 0 ? Infinity : 0));
  const trusted = !hit || hit.fetchedAt >= last + INGEST_LAG;
  const inWindow = after === null || post.createdUtc > after;
  const needPosts = inWindow && (!trusted || target.posts > (isOp ? 1 : 0));
  const needComments = inWindow && (!trusted || target.comments > threadComments);
  let fromCache = Boolean(hit);
  if (needPosts || needComments) {
    // "Before" counts can't change once the archive has everything up to the post, so a
    // saved answer fetched after that is reused.
    const beforeKey = `${CACHE_VERSION}|before|${user}|${post.subreddit.toLowerCase()}|${post.createdUtc}|${bucket}`;
    const saved = await cacheGet(cache, beforeKey, isBefore);
    let before;
    if (saved && saved.fetchedAt >= post.createdUtc + INGEST_LAG) {
      before = saved.value;
    } else {
      fromCache = false;
      before = await beforeCounts(client, username, post, { after, needPosts, needComments });
      await cacheSet(cache, beforeKey, before);
    }
    profile.targetPostsBefore = before.posts;
    profile.targetCommentsBefore = before.comments;
  }
  profile.cached = fromCache;
  return profile;
}

// Run `fn(item, index)` over `items` with at most `concurrency` calls in flight. Stops
// starting new items once `signal` is aborted; waits for the ones in flight, then
// rethrows the first failure.
export async function mapPool(items, concurrency, fn, signal = null) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (signal?.aborted) throw new Aborted("stopped");
      const i = next++;
      await fn(items[i], i);
    }
  };
  const workers = Math.max(1, Math.min(concurrency, items.length));
  await settleAll(Array.from({ length: workers }, worker));
}

function sum(map) {
  let t = 0;
  for (const n of map.values()) t += n;
  return t;
}

// Estimates the seconds left in a scan from the recent pace of finished users.
// Saved results finish instantly, so they don't count towards the pace; instead the share
// of users so far that came from saved results is assumed to hold for the rest. Between
// completions the estimate counts down, and it grows again if the next user is overdue
// (a slow server), so it never sits at "0" while work is still going. Pauses that stop
// every request (rate limits, see pause()) are left out of the pace, since they're
// one-offs, and the rest of a pause in progress is added on top.
export class Eta {
  static MIN_SAMPLES = 3; // fetched users needed before estimating
  static WINDOW = 20; // recent fetched users the pace is taken from

  constructor(total, now = monotonicNow) {
    this.total = total;
    this.now = now;
    this.start = now();
    this.done = 0;
    this.saved = 0;
    this.finished = []; // completion times of fetched (not saved) users
    this.estimate = null;
    this.estimatedAt = 0;
    this.pauses = []; // [start, end] of pauses that stop every request, in order
  }

  // Every request is paused until `until` (same clock as `now`).
  pause(until) {
    const t = this.now();
    const last = this.pauses.at(-1);
    if (last && t <= last[1]) last[1] = Math.max(last[1], until);
    else this.pauses.push([t, until]);
  }

  // A user finished; saved = its results were all reused.
  record(saved = false) {
    const t = this.now();
    this.done++;
    if (saved) this.saved++;
    else this.finished.push(t);
    if (this.finished.length > Eta.WINDOW + 1) this.finished.shift();
    this.estimate = this.finished.length ? this._left() * this._pace(t, 0) : null;
    this.estimatedAt = t;
  }

  // Seconds left, or null until there's enough to go on.
  secondsLeft() {
    if (this.done >= this.total) return 0;
    if (this.finished.length < Eta.MIN_SAMPLES || this.estimate === null) return null;
    const t = this.now();
    const countdown = this.estimate - this._active(this.estimatedAt, t);
    // If the next user finished right now, the pace would be this, with one fewer left.
    const overdue = Math.max(0, this._left() - this._fetchShare()) * this._pace(t, 1);
    const pauseLeft = Math.max(0, (this.pauses.at(-1)?.[1] ?? 0) - t);
    return Math.max(0, countdown, overdue) + pauseLeft;
  }

  // Seconds between a and b, less any pauses.
  _active(a, b) {
    let d = b - a;
    for (const [start, end] of this.pauses) d -= Math.max(0, Math.min(b, end) - Math.max(a, start));
    return d;
  }

  _fetchShare() {
    return this.done ? 1 - this.saved / this.done : 1;
  }

  // Users still to fetch, allowing for the expected share of saved results.
  _left() {
    return (this.total - this.done) * this._fetchShare();
  }

  // Seconds per fetched user over the recent window ending at t, counting `extra`
  // not-yet-finished users as done at t.
  _pace(t, extra) {
    const n = this.finished.length;
    const k = Math.min(n, Eta.WINDOW);
    const from = n > k ? this.finished[n - k - 1] : this.start;
    return this._active(from, t) / (k + extra);
  }
}

// Subreddits of a profile, filtered by minCount (target subreddit always kept) and
// sorted by total desc, then name; with targetFirst, the post's subreddit comes first.
export function sortedSubreddits(profile, post, minCount = 0, { targetFirst = false } = {}) {
  const target = post.subreddit.toLowerCase();
  const isTarget = (s) => s.name.toLowerCase() === target;
  return [...profile.subreddits]
    .map(([name, c]) => ({ name, posts: c.posts, comments: c.comments, total: c.posts + c.comments }))
    .filter((s) => s.total >= minCount || isTarget(s))
    .sort((a, b) => (targetFirst && isTarget(b) - isTarget(a)) ||
      b.total - a.total || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

// Link to the Arctic Shift search page listing an author's posts or comments in a
// subreddit, newest first. kind: "posts" | "comments"; after: epoch seconds or null.
export function arcticSearchUrl(kind, author, subreddit, after = null) {
  const q = new URLSearchParams({ fun: `${kind}_search`, author, subreddit });
  if (after !== null) q.set("after", String(after));
  q.set("limit", "100");
  q.set("sort", "desc");
  return `https://arctic-shift.photon-reddit.com/search?${q}`;
}

export const CSV_COLUMNS = [
  "username",
  "thread_comments",
  "target_subreddit",
  "target_posts_before",
  "target_comments_before",
  "subreddit",
  "posts",
  "comments",
  "total",
  "error",
];

function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Same layout as the Python CLI: one row per (user, subreddit).
export function toCsv(profiles, post, minCount = 0) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const p of profiles) {
    const base = {
      username: p.username,
      thread_comments: p.threadComments,
      target_subreddit: post.subreddit,
      target_posts_before: p.error ? "" : p.targetPostsBefore,
      target_comments_before: p.error ? "" : p.targetCommentsBefore,
      error: p.error || "",
    };
    const subs = sortedSubreddits(p, post, minCount);
    const rows = subs.length
      ? subs.map((s) => ({ ...base, subreddit: s.name, posts: s.posts, comments: s.comments, total: s.total }))
      : [base];
    for (const row of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
