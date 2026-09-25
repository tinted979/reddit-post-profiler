// Arctic Shift client and the profiling logic behind the web app: finding a thread's
// commenters, building each one's per-subreddit profile, and the CSV export. No DOM access
// here, so it runs under Node for the tests.

export const BASE_URL = "https://arctic-shift.photon-reddit.com";
// Sent with every request (as the Arctic Shift search site sends its own), so the archive's
// maintainer can tell this tool's traffic apart and get in touch rather than block it.
export const APP_TAG = "reddit-post-profiler";
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
export const INGEST_LAG = 3600;
// Prefix of every cache key; change it when the stored format changes.
const CACHE_VERSION = "v1";
// "Before" records moved to v2 when they gained the timeline facts (first, days).
const BEFORE_VERSION = "v2";
// Timestamps fetched per kind for the "before" timeline (the search endpoint's maximum).
const TIMELINE_LIMIT = 100;
// Rows per page of a covered subreddit's tail (see fetchTails): the search endpoint's
// largest `limit` ("auto" answered 100 too, checked 2026-09-25), so a short page marks the
// end without asking again.
const TAIL_PAGE = 100;
// Tail pages a scan may spend per subreddit and kind: about one per this many comments in
// the thread (asking per commenter instead costs a request or two each), within these
// bounds. Past that, the per-user path asks about what the tail didn't reach.
const TAIL_COMMENTS_PER_PAGE = 50;
const TAIL_MIN_PAGES = 2;
const TAIL_MAX_PAGES = 20;
// Pacing a scan starts with, and the range the page accepts. The server tops out at about
// 0.8 requests/s whatever the settings, so going faster only brings more "slow down"
// replies (see SECONDS_PER_REQUEST).
// Seconds in a day, for epoch-second arithmetic.
export const DAY = 86400;
// The history windows a scan can be limited to (years back from today).
export const HISTORY_YEARS = Object.freeze([1, 5, 10]);

export const SCAN_DEFAULTS = Object.freeze({ delay: 0.75, concurrency: 2, cacheDays: 7 });
export const SCAN_LIMITS = Object.freeze({
  delay: Object.freeze({ min: 0.25, max: 30 }),
  concurrency: Object.freeze({ min: 1, max: 5 }),
  maxUsers: Object.freeze({ min: 1, max: 1_000_000 }),
  cacheDays: Object.freeze({ min: 0, max: 365 }),
});

// The numeric scan options from the form or a share link, clamped to SCAN_LIMITS.
// Anything that isn't a finite number (a typo, "Infinity") takes its default; maxUsers
// below 1 means no cap (null), and an infinite one the largest cap.
export function clampScanNumbers({ maxUsers, delay, concurrency, cacheDays }) {
  const clamp = (n, { min, max }) => Math.min(max, Math.max(min, n));
  const finite = (n, fallback, limits) => (Number.isFinite(n) ? clamp(n, limits) : fallback);
  return {
    maxUsers: maxUsers >= 1 ? Math.floor(Math.min(maxUsers, SCAN_LIMITS.maxUsers.max)) : null,
    delay: finite(delay, SCAN_DEFAULTS.delay, SCAN_LIMITS.delay),
    concurrency: finite(Math.round(concurrency), SCAN_DEFAULTS.concurrency, SCAN_LIMITS.concurrency),
    cacheDays: cacheDays >= 0 ? finite(cacheDays, SCAN_DEFAULTS.cacheDays, SCAN_LIMITS.cacheDays) : SCAN_DEFAULTS.cacheDays,
  };
}

// Retry waits, in seconds (n: the attempt that failed, from 1). A 429 or a network error
// pauses every request on the client; "slow down" and 5xx replies make only that request
// wait, jittered (see JITTER) so parallel requests don't all retry at once.
const BACKOFF = Object.freeze({
  network: (n) => 5 * 2 ** (n - 1), // shared: 5, 10, 20, 40
  rateLimit: 30, // shared, when the reset header isn't readable (it isn't in browsers)
  slowDown: (n) => 2 * 2 ** (n - 1), // this request: 2, 4, 8, 16
  serverError: (n) => 2 ** n, // this request: 2, 4, 8, 16
  busy: 60, // shared, after a request gives up on a busy server (ServerBusy)
});
// A request's own waits are scaled by 1 ± JITTER at random.
const JITTER = 0.2;
// Successes in a row before the in-flight cap grows by one.
const GROW_AFTER = 10;

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

// An overloaded or rate-limiting server, or no connection: it won't answer a fallback
// either, so callers give up rather than send more (or heavier) queries.
const refusesMore = (err) => err instanceof ServerBusy || err.status === 429 || err.status === null;

const ID = "[0-9a-z]{1,13}";
const URL_PATTERNS = [
  new RegExp(`/comments/(${ID})(?:[/?#]|$)`, "i"),
  new RegExp(`redd\\.it/(${ID})(?:[/?#]|$)`, "i"),
  // Gallery links (reddit.com/gallery/<id>) are the post id too.
  new RegExp(`reddit\\.com/gallery/(${ID})(?:[/?#]|$)`, "i"),
];
const BARE_ID = new RegExp(`^(?:t3_)?(${ID})$`, "i");
// A subreddit, or a user's profile (u_<username>; usernames are 3–20 characters and may
// contain "-").
const SUBREDDIT = /^(?:\w{2,21}|u_[\w-]{3,20})$/;

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
      "(…/comments/<id>/… or …/gallery/<id>), a redd.it link, or the post id.",
  );
}

// A timer: calls `done` after `ms` and returns a function that cancels it.
const plainTimer = (ms, done) => {
  const t = setTimeout(done, ms);
  return () => clearTimeout(t);
};

// Resolves after `seconds`, or as soon as `signal` aborts. `timer` can be swapped for one
// that a hidden tab doesn't throttle (see backgroundSleep in app.js).
export function wait(seconds, signal = null, timer = plainTimer) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      cancel();
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const cancel = timer(seconds * 1000, done);
    signal?.addEventListener("abort", done);
  });
}

// Seconds on a clock that doesn't jump if the system time is changed mid-run.
const monotonicNow = () => (performance.timeOrigin + performance.now()) / 1000;

export class ArcticShiftClient {
  constructor({
    delay = SCAN_DEFAULTS.delay,
    maxInFlight = SCAN_DEFAULTS.concurrency,
    maxRetries = 4,
    maxRateLimitWaits = 10,
    baseUrl = BASE_URL,
    fetchFn = (...a) => globalThis.fetch(...a),
    sleep = wait,
    now = monotonicNow,
    signal = null,
    onWait = () => {},
    onPause = () => {},
    random = Math.random,
  } = {}) {
    Object.assign(this, { delay, maxInFlight, maxRetries, maxRateLimitWaits, baseUrl, signal, onWait, onPause });
    this._random = random;
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

  // The in-flight cap, requests in flight and requests waiting for a slot (for tests and
  // diagnostics; read-only).
  stats() {
    return { limit: this._limit, inFlight: this._inFlight, waiting: this._waiters.length };
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

  _jitter(seconds) {
    return seconds * (1 + JITTER * (2 * this._random() - 1));
  }

  _congested() {
    this._limit = Math.max(1, Math.floor(this._limit / 2));
    this._streak = 0;
  }

  _succeeded() {
    if (++this._streak >= GROW_AFTER && this._limit < this.maxInFlight) {
      this._limit++;
      this._streak = 0;
      this._wake();
    }
  }

  // One attempt: wait for a slot and a start time, fetch and parse. Returns {resp,
  // payload} (payload is null when the body isn't JSON); throws the fetch error on a
  // network failure, Aborted once stopped, and the error that made `group` give up if it
  // did meanwhile.
  async _attempt(url, group) {
    for (;;) {
      await this._acquire();
      try {
        await this._throttle();
      } catch (err) {
        this._release();
        throw err;
      }
      if (group?.failed) {
        this._release();
        throw group.error ?? new ServerBusy("server busy: dropped with the rest of its split"); // why the group gave up
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
  // are retried; a 429 or a network error pauses every request, a "slow down" answer or a
  // 5xx only this one, and each of those lowers the in-flight cap. Throws QueryTimeout
  // when the query is too heavy, ServerBusy when the server stays overloaded (and then
  // pauses every request for BACKOFF.busy), ArcticShiftError (with `status`) for anything
  // else, and Aborted once stopped.
  //
  // `group` ({failed}) ties the parts of one split together: once one gives up on a
  // server that won't answer (refusesMore, or a 5xx), the parts not yet sent are dropped
  // with that error instead of each making its own retries.
  async _get(path, params, group = null) {
    try {
      return await this._request(path, params, group);
    } catch (err) {
      // In a split, a server error that outlasts its retries counts too: the parts ask the
      // same endpoint, so the rest would fail the same way. (Outside a split a 5xx isn't
      // refusesMore: a failed search still falls back to the aggregate, another endpoint.)
      if (group && !group.failed && (refusesMore(err) || err.status >= 500)) Object.assign(group, { failed: true, error: err });
      throw err;
    }
  }

  async _request(path, params, group) {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    url.searchParams.set("meta-app", APP_TAG);
    let failures = 0;
    let slowdowns = 0;
    let rateLimitWaits = 0;
    for (;;) {
      this._checkAbort();
      let resp;
      let payload;
      try {
        ({ resp, payload } = await this._attempt(url.toString(), group));
      } catch (err) {
        this._checkAbort();
        if (err instanceof ArcticShiftError) throw err; // our own (a dropped split part), not the network
        // Browsers surface CORS-less error responses (e.g. some 429s) as network
        // errors, so back off generously.
        if (++failures > this.maxRetries) {
          throw new ArcticShiftError(`network error on ${path}: ${err.message ?? err}`);
        }
        this._congested();
        this._pause(BACKOFF.network(failures), "network error, retrying");
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
        this._pause(Number.isFinite(reset) && reset > 0 ? reset + 1 : BACKOFF.rateLimit, "rate limited");
        continue;
      }

      const error = payload && typeof payload === "object" && payload.error ? String(payload.error) : null;
      if (error && /timed out/i.test(error)) throw new QueryTimeout(error, resp.status);
      if (error && /slow down/i.test(error)) {
        // Undocumented: under load the server answers 422 "Timeout. Maybe slow down
        // a bit"; the same query usually succeeds after a pause. Only this request
        // waits; the lower in-flight cap is what eases the load.
        // A split's parts take turns, so each would reach its own limit only after all of
        // them had several goes: count the whole group's slow-downs too.
        if (group) group.slowdowns = (group.slowdowns ?? 0) + 1;
        if (++slowdowns > this.maxRetries || group?.slowdowns > this.maxRetries) {
          // Give the server a rest: every request on the client waits, including the
          // next users', instead of each starting its own round of retries.
          this._pause(BACKOFF.busy, "server busy");
          throw new ServerBusy(`server busy: ${error}`, resp.status);
        }
        this._congested();
        await this._sleep(this._jitter(BACKOFF.slowDown(slowdowns)), "server busy");
        continue;
      }
      if (resp.status >= 500 || (resp.ok && (payload === null || typeof payload !== "object" || !("data" in payload)))) {
        // Counted across a split's parts too, as with slow-downs.
        if (group && resp.status >= 500) group.serverErrors = (group.serverErrors ?? 0) + 1;
        if (++failures > this.maxRetries || group?.serverErrors > this.maxRetries) {
          throw new ArcticShiftError(`HTTP ${resp.status} on ${path}: ${error ?? "bad response"}`, resp.status);
        }
        if (resp.status >= 500) this._congested();
        await this._sleep(this._jitter(BACKOFF.serverError(failures)), "server error, retrying");
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
    // Every later query is built from these, so a reply that doesn't fit fails here rather
    // than sending before=NaN or links to the wrong place.
    const createdUtc = Math.trunc(Number(p.created_utc));
    if (p.id !== postId || !SUBREDDIT.test(p.subreddit) || !(createdUtc > 0)) {
      throw new ArcticShiftError(`unexpected post record for ${postId}`);
    }
    return {
      id: p.id,
      author: p.author || "[deleted]",
      subreddit: p.subreddit,
      createdUtc,
      title: p.title || "",
      // Reddit's count when archived, deleted comments included.
      numComments: Number(p.num_comments) || 0,
    };
  }

  // Every archived comment under a post, in one request, from the comment tree. Returns
  // null when the tree can't be trusted to be complete (collapsed "more" stubs, an
  // unexpected shape, the size limit reached, nothing returned, or an API error), so the
  // caller pages instead. A busy or rate-limiting server, or no connection, throws: paging
  // would only send it more requests.
  async threadCommentsTree(postId, limit = TREE_LIMIT) {
    let data;
    try {
      data = await this._get("/api/comments/tree", { link_id: postId, limit });
    } catch (err) {
      if (err instanceof ArcticShiftError && !refusesMore(err)) return null;
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

  // Every archived comment under a post.
  async *iterThreadComments(postId, pageSize = "auto") {
    for await (const page of this.iterAscending("/api/comments/search", { link_id: postId, fields: "id,author,created_utc" }, pageSize)) {
      yield* page;
    }
  }

  // Every row a search matches, oldest first, from `params.after` (exclusive) on, as pages of
  // the rows not seen before. The search endpoint has no cursor, so page on created_utc:
  // start the next page one second before the last one ended (rows can share a second) and
  // dedupe by id. With pageSize "auto" the server picks the page size, so only an empty
  // page, or two in a row with nothing new, marks the end; with a number, so does a short
  // page. After `maxPages` pages it stops early. Returns true if it reached the end.
  async *iterAscending(path, { after = null, ...params }, pageSize = "auto", { maxPages = Infinity } = {}) {
    const seen = new Set();
    let cursor = after;
    let stale = 0;
    for (let pages = 1; ; pages++) {
      const query = { ...params, limit: pageSize, sort: "asc" };
      if (cursor !== null) query.after = cursor;
      const page = await this._get(path, query);
      if (!Array.isArray(page) || !page.length) return true;
      const fresh = [];
      for (const row of page) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        fresh.push(row);
      }
      yield fresh;
      if (typeof pageSize === "number" && page.length < pageSize) return true;
      stale = fresh.length ? 0 : stale + 1;
      if (stale >= 2) return true;
      if (pages >= maxPages) return false;
      const lastTs = Math.trunc(Number(page[page.length - 1].created_utc));
      // A page with nothing new is stuck on one second: step past it (`after` is
      // exclusive, so after=lastTs starts at the next second).
      let next = fresh.length ? lastTs - 1 : lastTs;
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
      // A 4xx refusal (not a 429) means it can't answer for this user; a server that's
      // failing (5xx), busy or unreachable fails the request instead of sending the caller
      // on to the heavier yearly split.
      const refused = err instanceof ArcticShiftError && !(err instanceof QueryTimeout || err instanceof ServerBusy) &&
        err.status !== null && err.status !== 429 && err.status < 500;
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
  async subredditCounts(kind, author, { subreddit = null, after = null, before = null, only = null, attempts = 2, split = true, group = null } = {}) {
    for (let i = 0; i < attempts; i++) {
      try {
        return await this._aggregate(kind, author, { subreddit, after, before }, group);
      } catch (err) {
        if (!(err instanceof QueryTimeout) || (!split && i === attempts - 1)) throw err;
      }
    }
    // One group for the whole split (and any split inside it), so a part that gives up on a
    // busy server takes the unsent rest with it.
    const shared = group ?? { failed: false };
    const parts = only?.length && subreddit === null
      ? only.map((sub) => this.subredditCounts(kind, author, { subreddit: sub, after, before, group: shared }))
      : yearlyRanges(before, this._now(), after).map(([start, end]) =>
        this._aggregate(kind, author, { subreddit, after: start, before: end }, shared));
    const total = new Map();
    for (const part of await settleAll(parts)) {
      for (const [k, n] of part) total.set(k, (total.get(k) || 0) + n);
    }
    return total;
  }

  // Creation times (epoch seconds) of an author's posts or comments, newest first by
  // default, at most `limit`. (The created_utc aggregate would be cheaper, but it answers
  // all zeros, so the timeline is built from the items themselves.)
  async timestamps(kind, author, { subreddit = null, after = null, before = null, sort = "desc", limit = TIMELINE_LIMIT } = {}) {
    const params = { author, sort, limit, fields: "created_utc" };
    if (subreddit !== null) params.subreddit = subreddit;
    if (after !== null) params.after = after;
    if (before !== null) params.before = before;
    const data = await this._get(`/api/${kind}/search`, params);
    return (Array.isArray(data) ? data : [])
      .map((row) => Math.trunc(Number(row?.created_utc)))
      .filter((t) => Number.isFinite(t) && t > 0);
  }

  async _aggregate(kind, author, { subreddit = null, after = null, before = null } = {}, group = null) {
    // An empty limit returns every subreddit rather than the top few.
    const params = { aggregate: "subreddit", author, limit: "" };
    if (subreddit !== null) params.subreddit = subreddit;
    if (after !== null) params.after = after;
    if (before !== null) params.before = before;
    const data = await this._get(`/api/${kind}/search/aggregate`, params, group);
    const counts = new Map();
    for (const row of Array.isArray(data) ? data : []) {
      const n = Number(row?.count);
      if (typeof row?.key !== "string" || !Number.isFinite(n) || n < 0) continue;
      counts.set(row.key, (counts.get(row.key) || 0) + n);
    }
    return counts;
  }
}

// One [after, before] pair per calendar year (UTC), from the start of the archive or
// from `after`, up to `before`, to send to the API as they are: both bounds are exclusive
// there, so each year's `after` is a second before it starts. With no `before`, the last
// year's is null (no end), so `nowSeconds` only decides how many years there are and a
// clock running behind can't leave anything out.
export function yearlyRanges(before, nowSeconds, after = null) {
  const endYear = Math.max(ARCHIVE_START_YEAR, new Date((before ?? Math.trunc(nowSeconds)) * 1000).getUTCFullYear());
  const ranges = [];
  for (let year = ARCHIVE_START_YEAR; year <= endYear; year++) {
    const start = Math.max(Date.UTC(year, 0, 1) / 1000 - 1, after ?? -Infinity);
    const stop = year === endYear ? before : Math.min(Date.UTC(year + 1, 0, 1) / 1000, before ?? Infinity);
    if (stop === null || start < stop - 1) ranges.push([start, stop]);
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

// Tail pages a scan may spend per subreddit and kind, for a thread of `numComments`.
export function tailBudget(numComments) {
  const pages = Math.ceil((Number(numComments) || 0) / TAIL_COMMENTS_PER_PAGE);
  return Math.min(TAIL_MAX_PAGES, Math.max(TAIL_MIN_PAGES, pages));
}

const TAIL_FIELDS = { posts: "id,author,created_utc", comments: "id,author,created_utc,link_id" };

// What covered subreddits' archive files don't have yet, fetched once for the whole scan
// into `dumps`' tails: everyone's activity after the files end (a subreddit-wide search).
// Every commenter's "before" facts and archive lifetime counts then come from the files
// plus the tail, instead of each asking Arctic Shift about the same window.
//
// Which subreddits: all of `only` with the post's own, when the archive covers them all
// (lifetime counts need them all); otherwise the post's own, if the post is newer than its
// files. At most `budget` pages per subreddit and kind: past that, a tail covers up to the
// last whole second it reached, and the per-user path asks about the rest. A busy or
// rate-limiting server, or no connection, fails the scan, since asking per user would only
// send it more requests; another API error, such as a query timing out, leaves the tail
// where it got to. `now` gives epoch seconds: a tail that reaches the end is complete up to
// when it started.
export async function fetchTails(client, dumps, post, { only = null, budget = tailBudget(post.numComments), now = () => Date.now() / 1000 } = {}) {
  const wanted = only?.length ? parseSubreddits([post.subreddit, ...only]) : null;
  let subs = [];
  if (wanted?.every((sub) => dumps.covers(sub))) {
    subs = wanted;
  } else {
    const c = dumps.covers(post.subreddit);
    if (c && post.createdUtc - 1 > Math.min(c.postsThrough, c.commentsThrough)) subs = [post.subreddit];
  }
  for (const sub of subs) {
    await settleAll(KINDS.map((kind) => fetchTail(client, dumps, sub, kind, budget, Math.trunc(now()))));
  }
}

async function fetchTail(client, dumps, sub, kind, budget, started) {
  const name = dumps.covers(sub)?.name;
  if (!name) return;
  let newest = -Infinity;
  const pages = client.iterAscending(
    `/api/${kind}/search`,
    { subreddit: name, after: dumps.tailFrom(kind, sub), fields: TAIL_FIELDS[kind] },
    TAIL_PAGE,
    { maxPages: budget },
  );
  try {
    let next;
    while (!(next = await pages.next()).done) {
      dumps.addTail(kind, sub, next.value);
      for (const row of next.value) newest = Math.max(newest, Math.trunc(Number(row?.created_utc)) || -Infinity);
    }
    dumps.endTail(kind, sub, next.value ? { through: started, current: true } : { through: newest - 1, current: false });
  } catch (err) {
    dumps.endTail(kind, sub, { through: newest - 1, current: false });
    if (!(err instanceof ArcticShiftError) || refusesMore(err)) throw err;
  }
}

// Usernames as typed into "Skip users": "u/name", "/u/name" and profile links become "name";
// anything with characters outside a Reddit username is dropped, and repeats (in any case)
// are removed.
export function parseUsernames(names) {
  const seen = new Set();
  const out = [];
  for (const raw of names) {
    const name = String(raw)
      .trim()
      .replace(/^(?:(?:https?:)?\/\/)?(?:(?:www|old|new|m|np)\.)?reddit\.com(?=\/|$)/i, "")
      .replace(/^\/?u(?:ser)?\//i, "")
      .replace(/\/.*$/, "");
    if (/^[\w-]+$/.test(name) && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push(name);
    }
  }
  return out;
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
    if (SUBREDDIT.test(name) && !seen.has(name.toLowerCase())) {
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
async function lifetimeCounts(client, username, { wanted, after, skipInteractions = false }) {
  const first = await Promise.allSettled(
    KINDS.map((kind) => client.subredditCounts(kind, username, { after, split: false })),
  );
  for (const r of first) {
    if (r.status === "rejected" && !(r.reason instanceof QueryTimeout)) throw r.reason;
  }
  const done = (i) => first[i].status === "fulfilled";
  if (done(0) && done(1)) return { counts: mergeKinds(first.map((r) => r.value)), partial: false };
  if (!skipInteractions) {
    try {
      return { counts: await client.interactionCounts(username, { after }), partial: false };
    } catch (err) {
      if (!(err instanceof QueryTimeout || err instanceof Unsupported)) throw err;
    }
  }
  const parts = await settleAll(KINDS.map((kind, i) =>
    done(i) ? first[i].value : client.subredditCounts(kind, username, { after, only: wanted, attempts: 0 })));
  return { counts: mergeKinds(parts), partial: Boolean(wanted) };
}

// Lifetime counts from the archive, for a scan limited (`only`) to subreddits it covers:
// each wanted subreddit's items up to one cutoff (the earliest point every file can be
// trusted to), plus one interactions query for everything after it, posts and comments
// together (its `after` is exclusive, so nothing is counted twice). One request instead
// of two aggregates. Returns one shape on every path, tagged by `status`:
// {status: "answered", counts} for the wanted subreddits (so it's cached under its own
// `lifeonly` key rather than as the user's full profile); {status: "unavailable"} when the
// archive doesn't cover them all or can't be read (the aggregates then answer as usual);
// or {status: "no-interactions"} when interactions can't answer: the aggregates answer
// instead, but without retrying the interactions query they already found unusable.
//
// When every wanted subreddit's tail reached the present this scan (fetchTails), the files
// and tails already hold everything, so there's no cutoff and no interactions query.
async function archiveLifetime(client, dumps, username, wanted, after) {
  const covered = wanted.map((sub) => dumps.covers(sub));
  if (covered.some((c) => !c)) return { status: "unavailable" };
  const current = wanted.every((sub) => dumps.isCurrent?.(sub));
  const cutoff = current ? Infinity : minOf(covered.flatMap((c) => [c.postsThrough, c.commentsThrough]));
  if (!current && !Number.isFinite(cutoff)) return { status: "unavailable" };
  const counts = new Map();
  const byKey = new Map();
  const upToCutoff = (times) => times.filter((t) => t <= cutoff && (after === null || t > after)).length;
  try {
    const perSub = await settleAll(covered.map(async (c) => {
      const [posts, comments] = await settleAll(KINDS.map((k) => dumps.timestamps(k, c.name, username)));
      return [c.name, { posts: upToCutoff(posts), comments: upToCutoff(comments) }];
    }));
    for (const [name, c] of perSub) {
      counts.set(name, c);
      byKey.set(name.toLowerCase(), c);
    }
  } catch (err) {
    if (err instanceof Aborted) throw err;
    return { status: "unavailable" };
  }
  let recent = new Map();
  try {
    if (!current) recent = await client.interactionCounts(username, { after: after === null ? cutoff : Math.max(after, cutoff) });
  } catch (err) {
    if (err instanceof QueryTimeout || err instanceof Unsupported) return { status: "no-interactions" };
    throw err;
  }
  for (const [sub, c] of recent) {
    const mine = byKey.get(sub.toLowerCase());
    if (!mine) continue;
    mine.posts += c.posts;
    mine.comments += c.comments;
  }
  // For the end-of-scan note: a scan limited to covered subreddits whose lifetime counts
  // came from the archive files rather than Arctic Shift's aggregates.
  dumps.lifetimeReads = (dumps.lifetimeReads ?? 0) + 1;
  return { status: "answered", counts };
}

// The whole lifetime block for buildProfile, as rows ([subreddit, posts, comments][]):
// the `life` cache, the `lifeonly` cache (only with `only` and `dumps`), the archive
// attempt, the aggregate fallback (skipping the interactions retry once the archive
// already found it unusable), and the cache writes. Returns {rows, hit}: `hit` is the
// cache entry the rows came from (for its `fetchedAt`), or null when they're fresh.
async function lifetimeRows(client, dumps, cache, username, wanted, after, bucket) {
  const user = username.toLowerCase();
  const lifeKey = lifetimeKey(user, bucket);
  const hit = await cacheGet(cache, lifeKey, isRows);
  if (hit) return { rows: hit.value, hit };

  const onlyKey = wanted && dumps ? lifeOnlyKey(user, bucket, wanted) : null;
  const onlyHit = onlyKey ? await cacheGet(cache, onlyKey, isRows) : null;
  if (onlyHit) return { rows: onlyHit.value, hit: onlyHit };

  const archived = wanted && dumps ? await archiveLifetime(client, dumps, username, wanted, after) : null;
  const life = archived?.status === "answered"
    ? { counts: archived.counts, partial: true, source: "archive" }
    : await lifetimeCounts(client, username, { wanted, after, skipInteractions: archived?.status === "no-interactions" });

  const rows = [...life.counts].map(([sub, c]) => [sub, c.posts, c.comments]);
  if (!life.partial) {
    await cacheSet(cache, lifeKey, rows);
  } else if (life.source === "archive" && onlyKey) {
    await cacheSet(cache, onlyKey, rows);
  }
  return { rows, hit: null };
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

// Posts and comments in the post's subreddit before it was made, within the window, and
// when: `first` (earliest, epoch seconds) and `days` (distinct UTC days with activity).
// Only the kinds the lifetime totals don't already rule out are asked about.
//
// With `dumps` covering the subreddit, a kind's items come from its archive file up to
// where that file can be trusted (`through`); the API is asked only about the rest, from
// `through` to the post (`after` is exclusive, so nothing is counted twice). If the file
// can't be read, the API answers for the whole window as it would without an archive.
//
// From the API, one timestamp search per kind usually answers everything; past
// TIMELINE_LIMIT items the exact count and the first date take a query each, and `days`
// is a lower bound (complete: false). If the search fails, the counts come from the
// aggregate and the timeline is unknown, and `degraded` says not to save the answer.
async function beforeFacts(client, username, post, { after, needPosts, needComments, dumps = null }) {
  const fromApi = async (k, since) => {
    const opts = { subreddit: post.subreddit, after: since, before: post.createdUtc };
    let times;
    try {
      times = await client.timestamps(k, username, opts);
    } catch (err) {
      // Only an API error falls back (a bug should fail loudly), and not onto a server
      // that won't answer the heavier aggregate either.
      if (!(err instanceof ArcticShiftError) || refusesMore(err)) throw err;
      const count = sum(await client.subredditCounts(k, username, opts));
      return { count, times: null, first: null, complete: false, degraded: true };
    }
    if (times.length < TIMELINE_LIMIT) {
      return { count: times.length, times, first: minOf(times), complete: true };
    }
    const [counts, earliest] = await settleAll([
      client.subredditCounts(k, username, opts),
      client.timestamps(k, username, { ...opts, sort: "asc", limit: 1 }),
    ]);
    return { count: Math.max(sum(counts), times.length), times, first: minOf([...times, ...earliest]), complete: false };
  };
  const archive = dumps?.covers(post.subreddit) ?? null;
  const kind = async (k) => {
    const through = archive?.[k === "posts" ? "postsThrough" : "commentsThrough"];
    if (!Number.isFinite(through)) return fromApi(k, after);
    let saved;
    try {
      saved = await dumps.timestamps(k, post.subreddit, username);
    } catch (err) {
      if (err instanceof Aborted) throw err;
      return fromApi(k, after);
    }
    const times = saved.filter((t) => t < post.createdUtc && t <= through && (after === null || t > after));
    const fromFiles = { count: times.length, times, first: minOf(times), complete: true };
    if (post.createdUtc - 1 <= through) return fromFiles;
    const gap = await fromApi(k, after === null ? through : Math.max(after, through));
    return {
      count: fromFiles.count + gap.count,
      // An unknown gap timeline leaves only the files' days: a lower bound (complete: false).
      times: gap.times ? [...times, ...gap.times] : times.length ? times : null,
      first: fromFiles.first ?? gap.first,
      complete: gap.complete,
      degraded: gap.degraded,
    };
  };
  const [posts, comments] = await settleAll([
    needPosts ? kind("posts") : null,
    needComments ? kind("comments") : null,
  ]);
  const parts = [posts, comments].filter(Boolean);
  const known = parts.every((p) => p.times !== null);
  const days = new Set(parts.flatMap((p) => p.times ?? []).map((t) => Math.floor(t / DAY)));
  const firsts = parts.map((p) => p.first).filter((t) => t !== null);
  return {
    posts: posts?.count ?? 0,
    comments: comments?.count ?? 0,
    first: known ? minOf(firsts) : null,
    days: known ? days.size : null,
    complete: known && parts.every((p) => p.complete),
    // A timeline search failed and the aggregate stood in: a retry could do better, so the
    // answer isn't saved.
    degraded: parts.some((p) => p.degraded),
  };
}

// A non-negative number. (Number.isFinite, unlike isFinite, rejects strings and other
// non-numbers.)
const isCount = (n) => Number.isFinite(n) && n >= 0;
// [[subreddit, posts, comments], …]
const isRows = (v) =>
  Array.isArray(v) && v.every((r) => Array.isArray(r) && typeof r[0] === "string" && isCount(r[1]) && isCount(r[2]));
// {posts, comments, first, days, complete}; first and days may be null (unknown)
const isBefore = (v) => v !== null && typeof v === "object" && isCount(v.posts) && isCount(v.comments) &&
  (v.first === null || isCount(v.first)) && (v.days === null || isCount(v.days)) && typeof v.complete === "boolean";

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

// Round the window start to the day so cache keys stay stable between runs.
const windowBucket = (after) => (after === null ? "all" : String(Math.floor(after / DAY)));
const lifetimeKey = (user, bucket) => `${CACHE_VERSION}|life|${user.toLowerCase()}|${bucket}`;
// Archive-derived lifetime rows for one `only` set (see archiveLifetime): keyed separately
// from the full lifetime totals, since they cover just the wanted subreddits. Case- and
// order-insensitive in `wanted` so the same set hits the same key however it was typed.
const lifeOnlyKey = (user, bucket, wanted) =>
  `${CACHE_VERSION}|lifeonly|${user.toLowerCase()}|${bucket}|${wanted.map((s) => s.toLowerCase()).sort().join(",")}`;

// Scans larger than this many users ask first (or, from the queue, profile only this many).
export const LARGE_SCAN = 300;
// Rough requests per user: about 4 without saved totals (two totals, "before" searches
// and the odd retry), about 1 with them (the "before" search for this post).
const REQUESTS_NEW = 4;
const REQUESTS_SAVED = 1;
// Rough seconds per request, measured against the live API: 1.8 one user at a time and
// 1.3 with 2 or more in parallel. The server is the bottleneck, so past 2 in parallel
// it only answers "slow down" more often and gets no faster.
const SECONDS_PER_REQUEST = 1.8;
const SECONDS_PER_REQUEST_PARALLEL = 1.3;

// A rough cost for profiling `usernames` before starting: {users, saved, requests,
// seconds}. `saved` counts users whose lifetime totals are saved (and still fresh).
export async function estimateScan(cache, usernames, { after = null, delay = SCAN_DEFAULTS.delay, concurrency = SCAN_DEFAULTS.concurrency } = {}) {
  const bucket = windowBucket(after);
  let saved = 0;
  // In batches, so a big thread doesn't open thousands of storage reads at once.
  for (let i = 0; i < usernames.length; i += 100) {
    const hits = await Promise.all(usernames.slice(i, i + 100)
      .map((u) => cacheGet(cache, lifetimeKey(u, bucket), isRows)));
    saved += hits.filter(Boolean).length;
  }
  const requests = saved * REQUESTS_SAVED + (usernames.length - saved) * REQUESTS_NEW;
  const perRequest = concurrency > 1 ? SECONDS_PER_REQUEST_PARALLEL : SECONDS_PER_REQUEST;
  const seconds = requests * Math.max(delay, perRequest);
  return { users: usernames.length, saved, requests, seconds };
}

// A profile with no activity found yet: what buildProfile starts from, and (with `error`
// set) what the page shows for a user whose lookup failed.
export function emptyProfile(username, threadComments) {
  return {
    username,
    threadComments,
    targetPostsBefore: 0,
    targetCommentsBefore: 0,
    // When, before the post: earliest activity (epoch seconds) and distinct days active.
    // null = unknown; targetTimelineComplete false = days is only a lower bound.
    targetFirstBefore: null,
    targetDaysBefore: 0,
    targetTimelineComplete: true,
    subreddits: new Map(), // display name -> {posts, comments}
    error: null,
    cached: false,
  };
}

// Build a user's profile. `threadComments` is their comment count in the thread and
// `lastCommentUtc` when they made the newest one (null if unknown). With `only`, the
// profile lists just those subreddits (plus the post's own), including ones with no
// activity so the answer is explicit. With `after` (epoch seconds), only activity from
// then on is counted, "before the post" included. With `cache` ({get(key) -> {value,
// fetchedAt} | null, set(key, value)}), earlier results are reused and new ones saved.
// With `dumps` (a DumpSource, see dumps.js), "before" facts for a covered subreddit
// come from its archive files. With `only` and `dumps`, when the archive covers every
// wanted subreddit, lifetime counts come from it plus one interactions query (see
// archiveLifetime).
export async function buildProfile(client, username, threadComments, post, { only = null, after = null, lastCommentUtc = null, cache = null, dumps = null } = {}) {
  const profile = emptyProfile(username, threadComments);
  const user = username.toLowerCase();
  const bucket = windowBucket(after);
  const wanted = only?.length ? parseSubreddits([post.subreddit, ...only]) : null;

  const { rows, hit } = await lifetimeRows(client, dumps, cache, username, wanted, after, bucket);

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
    const beforeKey = `${BEFORE_VERSION}|before|${user}|${post.subreddit.toLowerCase()}|${post.createdUtc}|${bucket}`;
    const saved = await cacheGet(cache, beforeKey, isBefore);
    let before;
    if (saved && saved.fetchedAt >= post.createdUtc + INGEST_LAG) {
      before = saved.value;
    } else {
      fromCache = false;
      const { degraded, ...facts } = await beforeFacts(client, username, post, { after, needPosts, needComments, dumps });
      before = facts;
      if (!degraded) await cacheSet(cache, beforeKey, before);
    }
    Object.assign(profile, {
      targetPostsBefore: before.posts,
      targetCommentsBefore: before.comments,
      targetFirstBefore: before.first,
      targetDaysBefore: before.days,
      targetTimelineComplete: before.complete,
    });
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

// The smallest number in `list`, or null for none (Math.min(...list) overflows the stack
// for very long lists, such as a busy user's whole archive timeline).
function minOf(list) {
  let min = null;
  for (const n of list) if (min === null || n < min) min = n;
  return min;
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

// ---- Badges: new here / occasional / regular ----
// A user's badge rates their activity in the post's subreddit before the post by three
// facts: posts + comments, distinct days active, and tenure (days from their first post
// or comment there to the post). A tier's rule is met when every fact reaches its
// threshold; 0 turns a check off, and an unknown fact (older saved data, or a timeline
// query that failed) skips its check. Regular is tested first, then occasional; anyone
// else, including anyone with no activity at all, is new here.
export const DEFAULT_BADGES = Object.freeze({
  occasional: Object.freeze({ count: 3, days: 2, tenure: 14 }),
  regular: Object.freeze({ count: 20, days: 8, tenure: 90 }),
});
export const BADGE_TIERS = Object.freeze(["occasional", "regular"]);
export const BADGE_FIELDS = Object.freeze(["count", "days", "tenure"]);

// The facts a badge is decided on. days: null if unknown; exact: false if days is only a
// lower bound; tenureDays: null if unknown or there's no activity.
export function profileFacts(p, post) {
  const n = (p.targetPostsBefore || 0) + (p.targetCommentsBefore || 0);
  const first = Number.isFinite(p.targetFirstBefore) ? p.targetFirstBefore : null;
  return {
    n,
    days: n === 0 ? 0 : Number.isFinite(p.targetDaysBefore) ? p.targetDaysBefore : null,
    tenureDays: first === null ? null : Math.max(0, (post.createdUtc - first) / DAY),
    exact: p.targetTimelineComplete !== false,
  };
}

export function activityTier(facts, rules = DEFAULT_BADGES) {
  const meets = (r) => facts.n > 0 && facts.n >= r.count &&
    (facts.days === null || facts.days >= r.days) &&
    (facts.tenureDays === null || facts.tenureDays >= r.tenure);
  return meets(rules.regular) ? "regular" : meets(rules.occasional) ? "occasional" : "new";
}

// Rules as six numbers, "count,days,tenure" for occasional then regular (for links and
// storage), and back. Anything malformed gives null.
export function formatBadges(rules) {
  return BADGE_TIERS.flatMap((t) => BADGE_FIELDS.map((f) => rules[t][f])).join(",");
}

export function parseBadges(text) {
  const parts = String(text ?? "").split(",").map((x) => x.trim());
  if (parts.length !== 6 || !parts.every((x) => /^\d{1,5}$/.test(x))) return null;
  const n = parts.map(Number);
  return {
    occasional: { count: n[0], days: n[1], tenure: n[2] },
    regular: { count: n[3], days: n[4], tenure: n[5] },
  };
}

export function sameBadges(a, b) {
  return formatBadges(a) === formatBadges(b);
}

// [n, days, tenureDays] per profiled user (null for a failed one), kept with a saved scan
// so its tier counts can be worked out again under other rules without its profiles.
export function badgeFacts(profiles, post) {
  return profiles.map((p) => {
    if (p.error) return null;
    const f = profileFacts(p, post);
    return [f.n, f.days, f.tenureDays === null ? null : Math.round(f.tenureDays * 10) / 10];
  });
}

export function tierCounts(facts, rules = DEFAULT_BADGES) {
  const counts = { new: 0, occasional: 0, regular: 0 };
  for (const f of facts) {
    if (f) counts[activityTier({ n: f[0], days: f[1], tenureDays: f[2] }, rules)]++;
  }
  return counts;
}

// Profiles as plain data for storage (subreddits as [name, posts, comments] rows), and back.
export function serializeProfile(p) {
  return {
    username: p.username,
    threadComments: p.threadComments,
    targetPostsBefore: p.targetPostsBefore,
    targetCommentsBefore: p.targetCommentsBefore,
    targetFirstBefore: p.targetFirstBefore ?? null,
    targetDaysBefore: p.targetDaysBefore ?? null,
    targetTimelineComplete: p.targetTimelineComplete !== false,
    subreddits: [...p.subreddits].map(([name, c]) => [name, c.posts, c.comments]),
    rank: p.rank,
    cached: Boolean(p.cached),
    error: p.error ?? null,
    errorDetail: p.errorDetail ?? null,
  };
}

export function deserializeProfile(d) {
  const p = {
    ...d,
    subreddits: new Map(d.subreddits.map(([name, posts, comments]) => [name, { posts, comments }])),
  };
  if (!p.error) {
    delete p.error;
    delete p.errorDetail;
  }
  return p;
}

// What a scan found, for the list of saved scans. beforeKnown: false when the post is
// older than the history window, so there are no tiers to count.
export function scanStats(profiles, post, beforeKnown = true, rules = DEFAULT_BADGES) {
  const stats = { profiled: 0, failed: 0, new: 0, occasional: 0, regular: 0, subreddits: 0, posts: 0, comments: 0 };
  const subs = new Set();
  for (const p of profiles) {
    stats.profiled++;
    if (p.error) {
      stats.failed++;
      continue;
    }
    if (beforeKnown) stats[activityTier(profileFacts(p, post), rules)]++;
    for (const [name, c] of p.subreddits) {
      if (c.posts + c.comments > 0) subs.add(name.toLowerCase());
      stats.posts += c.posts;
      stats.comments += c.comments;
    }
  }
  stats.subreddits = subs.size;
  return stats;
}

// Links to a post and a subreddit on Reddit. The names come from the API (untrusted), so
// each is encoded: a "/" or "?" in one can't change the path.
export const redditSubredditUrl = (name) => `https://www.reddit.com/r/${encodeURIComponent(name)}/`;
export const redditPostUrl = (post) =>
  `https://www.reddit.com/r/${encodeURIComponent(post.subreddit)}/comments/${encodeURIComponent(post.id)}/`;

// Link to the Arctic Shift search page listing an author's posts or comments in a
// subreddit, newest first. kind: "posts" | "comments"; after: epoch seconds or null.
export function arcticSearchUrl(kind, author, subreddit, after = null) {
  const q = new URLSearchParams({ fun: `${kind}_search`, author, subreddit });
  if (after !== null) q.set("after", String(after));
  q.set("limit", "100");
  q.set("sort", "desc");
  return `${BASE_URL}/search?${q}`;
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
  // Badge facts:
  "target_active_days_before",
  "target_first_before_utc",
  "target_badge",
  // true, or false when target_active_days_before is only a lower bound; empty if unknown.
  "target_days_exact",
];

function csvCell(value) {
  let s = value === null || value === undefined ? "" : String(value);
  // Spreadsheets run text starting with these as a formula (a username can start with "-",
  // and an imported file's error text could be anything), so mark it as text.
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// One row per user and subreddit, with the badge facts at the end. beforeKnown: false when the post is older than the history window.
export function toCsv(profiles, post, minCount = 0, { rules = DEFAULT_BADGES, beforeKnown = true } = {}) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const p of profiles) {
    // With the post older than the history window, nothing before it was looked up: leave
    // those cells empty rather than write zeros that read as "no activity".
    const before = beforeKnown && !p.error;
    const base = {
      username: p.username,
      thread_comments: p.threadComments,
      target_subreddit: post.subreddit,
      target_posts_before: before ? p.targetPostsBefore : "",
      target_comments_before: before ? p.targetCommentsBefore : "",
      error: p.error || "",
    };
    if (before) {
      const f = profileFacts(p, post);
      const first = Number.isFinite(p.targetFirstBefore) ? new Date(p.targetFirstBefore * 1000).toISOString() : "";
      Object.assign(base, {
        // A lower bound when the API had 100+ posts or comments there to list (see
        // beforeFacts); target_days_exact says which.
        target_active_days_before: f.days === null ? "" : f.days,
        target_first_before_utc: first,
        target_badge: activityTier(f, rules),
        target_days_exact: f.days === null ? "" : f.n === 0 || f.exact,
      });
    }
    const subs = sortedSubreddits(p, post, minCount);
    const rows = subs.length
      ? subs.map((s) => ({ ...base, subreddit: s.name, posts: s.posts, comments: s.comments, total: s.total }))
      : [base];
    for (const row of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

// ---- Saved scans as a file ----

export const EXPORT_KIND = "rpp-saved-scans";
// Files exported before the rename to Reddit Post Profiler still import.
const OLD_EXPORT_KINDS = new Set(["reddit-tool-saved-scans"]);
export const EXPORT_VERSION = 1;

// The JSON file "Export" downloads: every saved scan, as stored.
export function exportScans(scans, now = Date.now() / 1000) {
  return JSON.stringify({ kind: EXPORT_KIND, version: EXPORT_VERSION, exportedAt: Math.floor(now), scans });
}

// Epoch seconds a Date can hold and format (up to the year 5138).
const isEpoch = (n) => isCount(n) && n < 1e11;
const isName = (s, max = 64) => typeof s === "string" && /^[\w-]+$/.test(s) && s.length <= max;
const orNull = (v, ok) => (v === null || v === undefined ? null : ok(v) ? v : undefined);

// One profile from an imported file, in serializeProfile form, or null if it doesn't look
// like one. Only the fields the page uses are kept.
function importProfile(d, index) {
  if (!d || typeof d !== "object" || !isName(d.username, 40) || !isCount(d.threadComments)) return null;
  if (!isCount(d.targetPostsBefore) || !isCount(d.targetCommentsBefore)) return null;
  const first = orNull(d.targetFirstBefore, isEpoch);
  const days = orNull(d.targetDaysBefore, isCount);
  if (first === undefined || days === undefined || !Array.isArray(d.subreddits)) return null;
  const subreddits = [];
  for (const row of d.subreddits) {
    if (!Array.isArray(row) || !isName(row[0]) || !isCount(row[1]) || !isCount(row[2])) return null;
    subreddits.push([row[0], row[1], row[2]]);
  }
  const text = (v) => (typeof v === "string" ? v.slice(0, 500) : null);
  return {
    username: d.username,
    threadComments: d.threadComments,
    targetPostsBefore: d.targetPostsBefore,
    targetCommentsBefore: d.targetCommentsBefore,
    targetFirstBefore: first,
    targetDaysBefore: days,
    targetTimelineComplete: d.targetTimelineComplete !== false,
    subreddits,
    rank: Number.isInteger(d.rank) && d.rank >= 0 ? d.rank : index,
    cached: Boolean(d.cached),
    error: text(d.error),
    errorDetail: text(d.errorDetail),
  };
}

// Check and tidy one scan ({summary, profiles}) from an imported file, which may have been
// edited or come from someone else. Returns {summary, profiles} ready for ScanStore.save,
// or null if it isn't a usable scan. The list's stats and badge facts are worked out again
// from the profiles rather than trusted.
export function importScan(rec) {
  const s = rec?.summary;
  const p = s?.post;
  if (!s || typeof s !== "object" || !p || typeof p !== "object" || !Array.isArray(rec.profiles)) return null;
  if (typeof p.id !== "string" || !/^[0-9a-z]{1,13}$/.test(p.id) || s.id !== p.id) return null;
  if (!isName(p.subreddit, 30) || !(p.author === "[deleted]" || isName(p.author, 40))) return null;
  if (!isEpoch(p.createdUtc) || !isEpoch(s.scannedAt)) return null;
  const profiles = rec.profiles.map(importProfile);
  if (profiles.includes(null)) return null;
  if (new Set(profiles.map((d) => d.username.toLowerCase())).size !== profiles.length) return null;
  // Ranks index the page's card slots, so renumber them 0..n-1 in their order: a huge rank
  // would make a sparse array every render walks, and a repeated one would hide a card.
  profiles
    .map((d, i) => [d, i])
    .sort(([a, i], [b, j]) => a.rank - b.rank || i - j)
    .forEach(([d], rank) => (d.rank = rank));
  profiles.sort((a, b) => a.rank - b.rank);
  const post = {
    id: p.id,
    author: p.author,
    subreddit: p.subreddit,
    createdUtc: Math.trunc(p.createdUtc),
    title: typeof p.title === "string" ? p.title.slice(0, 500) : "",
    numComments: isCount(p.numComments) ? p.numComments : 0,
  };
  const after = isEpoch(s.after) ? s.after : null;
  const beforeKnown = after === null || post.createdUtc > after;
  const live = profiles.map(deserializeProfile);
  const o = s.opts && typeof s.opts === "object" ? s.opts : {};
  // Cleaned the same way as the form's fields, so files saved before "Skip users" dropped
  // "u/" prefixes keep those names.
  const list = (v, parse) => (Array.isArray(v) ? parse(v.filter((x) => typeof x === "string")) : []);
  const years = HISTORY_YEARS.includes(o.years) ? o.years : null;
  const thread = s.thread && isCount(s.thread.comments) && isCount(s.thread.people)
    ? { comments: s.thread.comments, people: s.thread.people }
    : null;
  const summary = {
    id: post.id,
    post,
    scannedAt: s.scannedAt,
    complete: s.complete !== false,
    total: isCount(s.total) && s.total >= profiles.length ? s.total : profiles.length,
    thread,
    requests: isCount(s.requests) ? s.requests : 0,
    // Scans saved before archive requests were counted have none (null: not shown).
    archiveRequests: isCount(s.archiveRequests) ? s.archiveRequests : null,
    seconds: isCount(s.seconds) ? s.seconds : 0,
    profilingSeconds: isCount(s.profilingSeconds) ? s.profilingSeconds : null,
    fromSaved: isCount(s.fromSaved) ? s.fromSaved : 0,
    after,
    beforeKnown,
    opts: {
      only: list(o.only, parseSubreddits),
      years,
      maxUsers: Number.isInteger(o.maxUsers) && o.maxUsers > 0 ? o.maxUsers : null,
      includeOp: Boolean(o.includeOp),
      exclude: list(o.exclude, parseUsernames),
    },
    stats: scanStats(live, post, beforeKnown),
    facts: badgeFacts(live, post),
  };
  return { summary, profiles };
}

// The scans in an imported file's text. Throws an Error with a plain message if the file
// isn't an export from this tool; scans that don't check out are counted in `invalid`.
export function parseScanExport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't a saved-scans export (it isn't JSON).");
  }
  if ((data?.kind !== EXPORT_KIND && !OLD_EXPORT_KINDS.has(data?.kind)) || !Array.isArray(data.scans)) {
    throw new Error("That file isn't a saved-scans export from this tool.");
  }
  if (data.version > EXPORT_VERSION) {
    throw new Error("That file was exported by a newer version of this tool. Reload the page and try again.");
  }
  const scans = [];
  let invalid = 0;
  for (const rec of data.scans) {
    const scan = importScan(rec);
    if (scan) scans.push(scan);
    else invalid++;
  }
  return { scans, invalid };
}
