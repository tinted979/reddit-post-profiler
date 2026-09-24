// Browser port of the reddit_tool Python package: Arctic Shift client, commenter
// collection, profile building and CSV output. No DOM access here so it can be
// tested under Node.

export const BASE_URL = "https://arctic-shift.photon-reddit.com";
const ARCHIVE_START_YEAR = 2005;
const DEFAULT_EXCLUDED = new Set(["[deleted]", "[removed]", "automoderator"]);
// The interactions endpoint returns posts * weight_posts + comments * weight_comments per
// subreddit, so a large post weight packs both counts into one number.
const POST_WEIGHT = 1_000_000;
const TREE_LIMIT = 25_000;

export class ArcticShiftError extends Error {}
export class QueryTimeout extends ArcticShiftError {}
// The interactions endpoint can't answer for this user: too much data, or an answer we
// can't decode.
export class Unsupported extends ArcticShiftError {}
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
  throw new Error(
    "Can't find a post id in that input. Paste a reddit post URL " +
      "(…/comments/<id>/…), a redd.it link, or the post id.",
  );
}

export class ArcticShiftClient {
  constructor({
    delay = 2.0,
    maxInFlight = 3,
    maxRetries = 4,
    maxRateLimitWaits = 10,
    baseUrl = BASE_URL,
    fetchFn = (...a) => globalThis.fetch(...a),
    sleep = (s) => new Promise((r) => setTimeout(r, s * 1000)),
    now = () => Date.now() / 1000,
    signal = null,
    onWait = () => {},
  } = {}) {
    Object.assign(this, { delay, maxInFlight, maxRetries, maxRateLimitWaits, baseUrl, signal, onWait });
    this._fetch = fetchFn;
    this._sleepFn = sleep;
    this._now = now;
    // Request starts are spaced `delay` apart; a 429 pushes `_pausedUntil` forward for
    // every caller sharing this client.
    this._nextSlot = 0;
    this._pausedUntil = 0;
    this._pauseReason = null;
    // The server struggles with several heavy queries at once (it answers "slow down"),
    // so cap how many are in flight: halve the cap when it complains, and raise it
    // again one step at a time after a run of successes.
    this._limit = Math.max(1, maxInFlight);
    this._inFlight = 0;
    this._waiters = [];
    this._streak = 0;
    this.requests = 0;
  }

  _checkAbort() {
    if (this.signal?.aborted) throw new Aborted("stopped");
  }

  async _sleep(seconds, reason) {
    if (reason) this.onWait(reason, seconds);
    await this._sleepFn(seconds);
    if (reason) this.onWait(null, 0);
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
    while (this._inFlight >= this._limit) {
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

  // One attempt: wait for a slot, fetch and parse. Returns {resp, payload}; throws the
  // fetch error on network failure.
  async _attempt(url) {
    await this._acquire();
    try {
      await this._throttle();
      this.requests++;
      const resp = await this._fetch(url, { signal: this.signal ?? undefined });
      let payload = null;
      try {
        payload = await resp.json();
      } catch {
        payload = null;
      }
      return { resp, payload };
    } finally {
      this._release();
    }
  }

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
        failures++;
        if (failures > this.maxRetries) {
          throw new ArcticShiftError(`network error on ${path}: ${err.message ?? err}`);
        }
        this._congested();
        this._pause(5 * 2 ** (failures - 1), "network error, retrying");
        continue;
      }

      if (resp.status === 429) {
        rateLimitWaits++;
        if (rateLimitWaits > this.maxRateLimitWaits) {
          throw new ArcticShiftError(`still rate limited on ${path}, giving up`);
        }
        // X-RateLimit-Reset isn't exposed to browsers via CORS; fall back to 30s.
        const reset = Number(resp.headers.get("X-RateLimit-Reset"));
        this._congested();
        this._pause(Number.isFinite(reset) && reset > 0 ? reset + 1 : 30, "rate limited");
        continue;
      }

      const error = payload && typeof payload === "object" ? payload.error : null;
      if (error && /timed out/i.test(error)) throw new QueryTimeout(error);
      if (error && /slow down/i.test(error)) {
        // Undocumented: under load the server answers 422 "Timeout. Maybe slow down
        // a bit"; the same query usually succeeds after a pause. Only this request
        // waits; the lower in-flight cap is what eases the load.
        slowdowns++;
        if (slowdowns > this.maxRetries) throw new QueryTimeout(error);
        this._congested();
        await this._sleep(2 * 2 ** (slowdowns - 1), "server busy");
        continue;
      }
      if (resp.status >= 500 || payload === null) {
        failures++;
        if (failures > this.maxRetries) {
          throw new ArcticShiftError(`HTTP ${resp.status} on ${path}: ${error ?? "bad response"}`);
        }
        await this._sleep(2 ** failures, "server error, retrying");
        continue;
      }
      if (error || resp.status >= 400) {
        const err = new ArcticShiftError(`HTTP ${resp.status} on ${path}: ${error}`);
        err.status = resp.status;
        throw err;
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
    if (!data || !data.length) return null;
    const p = data[0];
    return {
      id: p.id,
      author: p.author || "[deleted]",
      subreddit: p.subreddit,
      createdUtc: Math.trunc(Number(p.created_utc)),
      title: p.title || "",
    };
  }

  // Every archived comment under a post, in one request, from the comment tree. Returns
  // null when the tree can't be trusted to be complete (collapsed "more" stubs, the size
  // limit reached, nothing returned, or an error), so the caller pages instead.
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
    let complete = true;
    const walk = (nodes) => {
      for (const node of Array.isArray(nodes) ? nodes : []) {
        if (!node || typeof node !== "object") continue;
        if (node.kind === "more") {
          complete = false;
          continue;
        }
        const d = node.data ?? {};
        if (node.kind === "t1" && d.id && !seen.has(d.id)) {
          seen.add(d.id);
          out.push({ id: d.id, author: d.author, created_utc: d.created_utc });
        }
        if (d.replies && typeof d.replies === "object") walk(d.replies.data?.children);
      }
    };
    walk(data);
    return complete && out.length > 0 && out.length < limit ? out : null;
  }

  // Every archived comment under a post. The search endpoint has no cursor, so page
  // on created_utc and dedupe by id. With pageSize "auto" the server picks the page
  // size, so only an empty page marks the end.
  async *iterThreadComments(postId, pageSize = "auto") {
    const seen = new Set();
    let cursor = null;
    let stale = 0;
    for (;;) {
      const params = { link_id: postId, limit: pageSize, sort: "asc", fields: "id,author,created_utc" };
      if (cursor !== null) params.after = cursor;
      const page = (await this._get("/api/comments/search", params)) || [];
      if (!page.length) return;
      let fresh = 0;
      for (const c of page) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        fresh++;
        yield c;
      }
      if (typeof pageSize === "number" && page.length < pageSize) return;
      // Two pages in a row with nothing new: the cursor isn't moving us forward.
      stale = fresh ? 0 : stale + 1;
      if (stale >= 2) return;
      const lastTs = Math.trunc(Number(page[page.length - 1].created_utc));
      let next = fresh ? lastTs - 1 : lastTs + 1;
      if (cursor !== null && next <= cursor) next = cursor + 1;
      cursor = next;
    }
  }

  // Map of subreddit -> {posts, comments} from one interactions query. `after`/`before`
  // bound the time window (epoch seconds). Throws Unsupported when the server refuses the
  // user or the packed counts can't be decoded.
  async interactionCounts(author, { after = null, before = null } = {}) {
    const params = { author, limit: "", weight_posts: POST_WEIGHT, weight_comments: 1 };
    if (after !== null) params.after = after;
    if (before !== null) params.before = before;
    let data;
    try {
      data = (await this._get("/api/users/interactions/subreddits", params)) || [];
    } catch (err) {
      if (err instanceof ArcticShiftError && err.status >= 400 && err.status < 500) throw new Unsupported(err.message);
      throw err;
    }
    const counts = new Map();
    for (const row of data) {
      const n = Number(row.count);
      if (!Number.isSafeInteger(n) || n < 0) throw new Unsupported(`can't decode count ${row.count}`);
      const c = counts.get(row.subreddit) ?? { posts: 0, comments: 0 };
      c.posts += Math.floor(n / POST_WEIGHT);
      c.comments += n % POST_WEIGHT;
      counts.set(row.subreddit, c);
    }
    return counts;
  }

  // Map of subreddit -> count for `kind` ("posts" | "comments"). Retries a timed-out
  // aggregation once, then falls back: to one query per subreddit in `only` when given
  // (all we need, and far cheaper for very active users), else to yearly chunks. With
  // `split: false` it throws QueryTimeout instead of falling back.
  // `after`/`before` bound the time window (epoch seconds).
  async subredditCounts(kind, author, { subreddit = null, after = null, before = null, only = null, split = true } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this._aggregate(kind, author, { subreddit, after, before });
      } catch (err) {
        if (!(err instanceof QueryTimeout) || (!split && attempt === 1)) throw err;
      }
    }
    const total = new Map();
    if (only?.length && subreddit === null) {
      for (const sub of only) {
        for (const [k, n] of await this.subredditCounts(kind, author, { subreddit: sub, after, before })) {
          total.set(k, (total.get(k) || 0) + n);
        }
      }
      return total;
    }
    for (const [start, end] of yearlyRanges(before, this._now(), after)) {
      const part = await this._aggregate(kind, author, { subreddit, after: start, before: end });
      for (const [k, n] of part) total.set(k, (total.get(k) || 0) + n);
    }
    return total;
  }

  async _aggregate(kind, author, { subreddit = null, after = null, before = null } = {}) {
    const params = { aggregate: "subreddit", author, limit: "" };
    if (subreddit !== null) params.subreddit = subreddit;
    if (after !== null) params.after = after;
    if (before !== null) params.before = before;
    const data = (await this._get(`/api/${kind}/search/aggregate`, params)) || [];
    const counts = new Map();
    for (const row of data) counts.set(row.key, (counts.get(row.key) || 0) + Number(row.count));
    return counts;
  }
}

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

// Map of author -> comments in the thread.
export async function collectCommenters(client, post, { exclude = [], includeOp = false } = {}) {
  const excluded = new Set(DEFAULT_EXCLUDED);
  for (const name of exclude) excluded.add(name.toLowerCase().replace(/^\/?u\//, ""));
  const counts = new Map();
  const comments = (await client.threadCommentsTree(post.id)) ?? client.iterThreadComments(post.id);
  for await (const c of comments) {
    const author = c.author;
    if (author && !excluded.has(author.toLowerCase())) counts.set(author, (counts.get(author) || 0) + 1);
  }
  if (includeOp && !excluded.has(post.author.toLowerCase()) && !counts.has(post.author)) {
    counts.set(post.author, 0);
  }
  return counts;
}

// Normalise a list of subreddit names ("r/Foo", "/r/foo", "Foo") to bare names.
export function parseSubreddits(names) {
  const seen = new Set();
  const out = [];
  for (const raw of names) {
    const name = raw.trim().replace(/^\/?r\//i, "");
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push(name);
    }
  }
  return out;
}

const KINDS = ["posts", "comments"];

// Lifetime counts as Map<subreddit, {posts, comments}>. The per-kind aggregates are the
// quickest answer for most users. When they time out (a very active user), one
// interactions query usually still answers; failing that, split the aggregates up.
// `partial` marks a result limited to `wanted`, which mustn't be cached.
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
  const parts = await Promise.all(
    KINDS.map((kind, i) => (done(i) ? first[i].value : client.subredditCounts(kind, username, { after, only: wanted }))),
  );
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
// Aggregates filtered to one subreddit are quick, so ask only for the kinds needed.
async function beforeCounts(client, username, post, { after, needPosts, needComments }) {
  const opts = { subreddit: post.subreddit, after, before: post.createdUtc };
  const [posts, comments] = await Promise.all([
    needPosts ? client.subredditCounts("posts", username, opts) : null,
    needComments ? client.subredditCounts("comments", username, opts) : null,
  ]);
  return { posts: posts ? sum(posts) : 0, comments: comments ? sum(comments) : 0 };
}

// Arctic Shift takes about 36 hours to settle, so lifetime counts fetched sooner than
// this after the post may not include the thread's comments yet.
const SETTLE_SECONDS = 2 * 86400;

async function cacheGet(cache, key) {
  try {
    return (await cache?.get(key)) ?? null;
  } catch {
    return null;
  }
}

async function cacheSet(cache, key, value) {
  try {
    await cache?.set(key, value);
  } catch {
    // Caching is best-effort.
  }
}

// Build a user's profile. With `only`, the profile lists just those subreddits (plus the
// post's own), including ones with no activity so the answer is explicit. With `after`
// (epoch seconds), only activity from then on is counted, "before the post" included.
// With `cache` ({get(key) -> {value, fetchedAt} | null, set(key, value)}), results of
// earlier runs are reused and new ones stored.
export async function buildProfile(client, username, threadComments, post, { only = null, after = null, cache = null } = {}) {
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

  const lifeKey = `life|${user}|${bucket}`;
  const hit = await cacheGet(cache, lifeKey);
  let rows;
  // Whether the lifetime totals are known to include this thread's comments.
  let settled = true;
  if (hit) {
    rows = hit.value;
    settled = hit.fetchedAt >= post.createdUtc + SETTLE_SECONDS;
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
  // A post older than the window has no "before" inside it at all.
  const target = byKey.get(post.subreddit.toLowerCase()) ?? { posts: 0, comments: 0 };
  const isOp = user === post.author.toLowerCase();
  const inWindow = after === null || post.createdUtc > after;
  const needPosts = inWindow && (!settled || target.posts > (isOp ? 1 : 0));
  const needComments = inWindow && (!settled || target.comments > threadComments);
  let beforeFromCache = true;
  if (needPosts || needComments) {
    const beforeKey = `before|${user}|${post.subreddit.toLowerCase()}|${post.createdUtc}|${bucket}`;
    const saved = await cacheGet(cache, beforeKey);
    let before = saved?.value;
    if (!before) {
      beforeFromCache = false;
      before = await beforeCounts(client, username, post, { after, needPosts, needComments });
      await cacheSet(cache, beforeKey, before);
    }
    profile.targetPostsBefore = before.posts;
    profile.targetCommentsBefore = before.comments;
  }
  profile.cached = Boolean(hit) && beforeFromCache;
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
  const results = await Promise.allSettled(Array.from({ length: workers }, worker));
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
}

function sum(map) {
  let t = 0;
  for (const n of map.values()) t += n;
  return t;
}

// Subreddits of a profile, filtered by minCount (target subreddit always kept) and
// sorted by total desc, then name.
export function sortedSubreddits(profile, post, minCount = 0) {
  const target = post.subreddit.toLowerCase();
  return [...profile.subreddits]
    .map(([name, c]) => ({ name, posts: c.posts, comments: c.comments, total: c.posts + c.comments }))
    .filter((s) => s.total >= minCount || s.name.toLowerCase() === target)
    .sort((a, b) => b.total - a.total || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
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
