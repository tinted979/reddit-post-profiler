// Browser port of the reddit_tool Python package: Arctic Shift client, commenter
// collection, profile building and CSV output. No DOM access here so it can be
// tested under Node.

export const BASE_URL = "https://arctic-shift.photon-reddit.com";
const ARCHIVE_START_YEAR = 2005;
const DEFAULT_EXCLUDED = new Set(["[deleted]", "[removed]", "automoderator"]);

export class ArcticShiftError extends Error {}
export class QueryTimeout extends ArcticShiftError {}
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
    maxRetries = 4,
    maxRateLimitWaits = 10,
    baseUrl = BASE_URL,
    fetchFn = (...a) => globalThis.fetch(...a),
    sleep = (s) => new Promise((r) => setTimeout(r, s * 1000)),
    now = () => Date.now() / 1000,
    signal = null,
    onWait = () => {},
  } = {}) {
    Object.assign(this, { delay, maxRetries, maxRateLimitWaits, baseUrl, signal, onWait });
    this._fetch = fetchFn;
    this._sleepFn = sleep;
    this._now = now;
    // Request starts are spaced `_interval` apart (never below `delay`); back-offs widen
    // it and push `_pausedUntil` forward for every caller sharing this client.
    this._interval = delay;
    this._nextSlot = 0;
    this._pausedUntil = 0;
    this._pauseReason = null;
    this._streak = 0;
    this.requests = 0;
  }

  _checkAbort() {
    if (this.signal?.aborted) throw new Aborted("stopped");
  }

  async _sleep(seconds, reason) {
    if (reason) this.onWait(reason, seconds);
    await this._sleepFn(seconds);
    this._checkAbort();
  }

  // Reserve the next start slot synchronously, so concurrent callers can't grab the
  // same one, then wait for it. Re-check afterwards in case a back-off began meanwhile.
  async _throttle() {
    for (;;) {
      const now = this._now();
      const start = Math.max(now, this._nextSlot, this._pausedUntil);
      this._nextSlot = start + this._interval;
      if (start <= now) return;
      await this._sleep(start - now, this._pausedUntil > now ? this._pauseReason : null);
      if (this._pausedUntil <= this._now()) return;
    }
  }

  // Pause every request on this client for `seconds` and slow the pace down.
  _backoff(seconds, reason) {
    const until = this._now() + seconds;
    if (until > this._pausedUntil) {
      this._pausedUntil = until;
      this._pauseReason = reason;
    }
    this._interval = Math.min(Math.max(this._interval * 2, 1), Math.max(5, this.delay));
    this._streak = 0;
  }

  // After a run of successes, speed back up towards the configured delay.
  _succeeded() {
    if (++this._streak >= 20 && this._interval > this.delay) {
      this._interval = Math.max(this.delay, this._interval / 2);
      this._streak = 0;
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
      await this._throttle();
      let resp;
      try {
        this.requests++;
        resp = await this._fetch(url.toString(), { signal: this.signal ?? undefined });
      } catch (err) {
        this._checkAbort();
        // Browsers surface CORS-less error responses (e.g. some 429s) as network
        // errors, so back off generously.
        failures++;
        if (failures > this.maxRetries) {
          throw new ArcticShiftError(`network error on ${path}: ${err.message ?? err}`);
        }
        this._backoff(5 * 2 ** (failures - 1), "network error, retrying");
        continue;
      }

      if (resp.status === 429) {
        rateLimitWaits++;
        if (rateLimitWaits > this.maxRateLimitWaits) {
          throw new ArcticShiftError(`still rate limited on ${path}, giving up`);
        }
        // X-RateLimit-Reset isn't exposed to browsers via CORS; fall back to 30s.
        const reset = Number(resp.headers.get("X-RateLimit-Reset"));
        this._backoff(Number.isFinite(reset) && reset > 0 ? reset + 1 : 30, "rate limited");
        continue;
      }

      let payload = null;
      try {
        payload = await resp.json();
      } catch {
        payload = null;
      }
      const error = payload && typeof payload === "object" ? payload.error : null;
      if (error && /timed out/i.test(error)) throw new QueryTimeout(error);
      if (error && /slow down/i.test(error)) {
        // Undocumented: under load the server answers 422 "Timeout. Maybe slow down
        // a bit"; the same query usually succeeds after a pause.
        slowdowns++;
        if (slowdowns > this.maxRetries) throw new QueryTimeout(error);
        this._backoff(5 * 2 ** (slowdowns - 1), "server busy");
        continue;
      }
      if (resp.status >= 500 || payload === null) {
        failures++;
        if (failures > this.maxRetries) {
          throw new ArcticShiftError(`HTTP ${resp.status} on ${path}: ${error ?? "bad response"}`);
        }
        this._backoff(2 ** failures, "server error, retrying");
        continue;
      }
      if (error || resp.status >= 400) {
        throw new ArcticShiftError(`HTTP ${resp.status} on ${path}: ${error}`);
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

  // Every archived comment under a post. The search endpoint has no cursor, so page
  // on created_utc and dedupe by id.
  async *iterThreadComments(postId, pageSize = 100) {
    const seen = new Set();
    let cursor = null;
    for (;;) {
      const params = { link_id: postId, limit: pageSize, sort: "asc", fields: "id,author,created_utc" };
      if (cursor !== null) params.after = cursor;
      const page = (await this._get("/api/comments/search", params)) || [];
      let fresh = 0;
      for (const c of page) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        fresh++;
        yield c;
      }
      if (page.length < pageSize) return;
      const lastTs = Math.trunc(Number(page[page.length - 1].created_utc));
      let next = fresh ? lastTs - 1 : lastTs + 1;
      if (cursor !== null && next <= cursor) next = cursor + 1;
      cursor = next;
    }
  }

  // Map of subreddit -> count for `kind` ("posts" | "comments"). Retries a timed-out
  // aggregation once, then falls back: to one query per subreddit in `only` when given
  // (all we need, and far cheaper for very active users), else to yearly chunks.
  // `after`/`before` bound the time window (epoch seconds).
  async subredditCounts(kind, author, { subreddit = null, after = null, before = null, only = null } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this._aggregate(kind, author, { subreddit, after, before });
      } catch (err) {
        if (!(err instanceof QueryTimeout)) throw err;
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
  for await (const c of client.iterThreadComments(post.id)) {
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

// Build a user's profile. With `only`, the profile lists just those subreddits (plus the
// post's own), including ones with no activity so the answer is explicit. With `after`
// (epoch seconds), only activity from then on is counted, "before the post" included.
export async function buildProfile(client, username, threadComments, post, { only = null, after = null } = {}) {
  const profile = {
    username,
    threadComments,
    targetPostsBefore: 0,
    targetCommentsBefore: 0,
    subreddits: new Map(), // display name -> {posts, comments}
    error: null,
  };
  const byKey = new Map();
  const wanted = only?.length ? parseSubreddits([post.subreddit, ...only]) : null;
  const lifetime = await Promise.all([
    client.subredditCounts("posts", username, { only: wanted, after }),
    client.subredditCounts("comments", username, { only: wanted, after }),
  ]);
  for (const [i, kind] of ["posts", "comments"].entries()) {
    for (const [sub, n] of lifetime[i]) {
      // Merge case-insensitively, keeping the first spelling we saw.
      let counts = byKey.get(sub.toLowerCase());
      if (!counts) {
        counts = { posts: 0, comments: 0 };
        byKey.set(sub.toLowerCase(), counts);
        profile.subreddits.set(sub, counts);
      }
      counts[kind] += n;
    }
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
  const isOp = username.toLowerCase() === post.author.toLowerCase();
  const inWindow = after === null || post.createdUtc > after;
  const before = { subreddit: post.subreddit, after, before: post.createdUtc };
  const [postsBefore, commentsBefore] = await Promise.all([
    inWindow && target.posts > (isOp ? 1 : 0) ? client.subredditCounts("posts", username, before) : null,
    inWindow && target.comments > threadComments ? client.subredditCounts("comments", username, before) : null,
  ]);
  profile.targetPostsBefore = postsBefore ? sum(postsBefore) : 0;
  profile.targetCommentsBefore = commentsBefore ? sum(commentsBefore) : 0;
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
