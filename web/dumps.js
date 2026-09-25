// Archive files for covered subreddits (built by tools/build_dumps.py and served from R2):
// each author's posts and comments in the subreddit, read with range requests, so the
// "before" facts need no Arctic Shift searches. What's newer than the files is a tail that
// core.js's fetchTails gets once per scan for the whole subreddit (TailStore below).
// See .claude/rules/archive.md and docs/adr/0005.

import { Aborted, INGEST_LAG } from "./core.js";
import { asyncBufferFromUrl, cachedAsyncBuffer, parquetMetadataAsync, parquetQuery } from "./hyparquet.js";

export const DUMPS_URL = "https://rpp-db.tinted979.dev";
// The manifest format this page reads (FORMAT in tools/build_dumps.py).
export const DUMP_FORMAT = 1;
// The file for each kind, as named in the manifest.
const FILES = { posts: "posts_by_author", comments: "comments_by_author" };
// Each thread's comments (link_id, author as written, time), sorted by thread. Optional: a
// subreddit without it is still covered, and its threads come from the API.
const LINK_FILE = "comments_by_link";
// Where a manifest may point: r/<subreddit>/<version>/<name>.parquet under the base URL.
const FILE_PATH = /^r\/\w{2,21}\/\w[\w.-]{0,39}\/\w+\.parquet$/;
const isTime = (n) => Number.isSafeInteger(n) && n > 0;
// Where a covered subreddit's `kind` file is trusted to.
const filesThrough = (s, kind) => (kind === "posts" ? s.postsThrough : s.commentsThrough);
// A subreddit name, as Reddit allows them.
const SUBREDDIT = /^\w{2,21}$/;
// How far past the page's clock a manifest's cutoffs may be (clock skew), in seconds.
const CLOCK_SLACK = 86400;
// Accounts the archive leaves out, as tools/build_dumps.py does.
const SKIPPED = new Set(["[deleted]", "[removed]", "automoderator"]);

// The file an archive request (`onRequest`'s URL) is for, for the request breakdown:
// "manifest", or a Parquet file's name without its extension.
export function archiveFileName(url) {
  return String(url).split("/").pop().replace(/\.(parquet|json)$/, "");
}

// The archive files can't answer (a network error, a bad file). Callers use the API.
export class DumpUnavailable extends Error {}

// Reads a remote file with range requests, keeping what it has fetched. Each range read
// (hyparquet's `slice`) gets its own timeout via a custom `fetch`, on top of the run's
// Stop signal, so a stalled connection can't hang a read forever. `onRequest` is called
// once per request sent, for the scan's request count.
async function urlFile(url, byteLength, signal, timeoutMs = 20000, { fetchFn = (...a) => globalThis.fetch(...a), onRequest = null } = {}) {
  const fetchWithTimeout = (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const merged = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    onRequest?.(input);
    return fetchFn(input, { ...init, signal: merged });
  };
  return cachedAsyncBuffer(await asyncBufferFromUrl({
    url, byteLength, requestInit: { signal: signal ?? undefined }, fetch: fetchWithTimeout,
  }));
}

// The covered subreddits in a manifest, keyed by lowercase name. The manifest is fetched,
// so it's checked like any other untrusted input; anything that doesn't check out is left
// out. `postsThrough`/`commentsThrough` are where the files can be trusted to: an hour
// before their newest item, in case the newest were archived late. A cutoff past `now`
// (epoch seconds) is rejected: it would make the page skip the API for recent activity.
export function parseManifest(data, now = Date.now() / 1000) {
  const subs = new Map();
  if (data?.format !== DUMP_FORMAT || !data.subreddits || typeof data.subreddits !== "object") return subs;
  for (const [key, s] of Object.entries(data.subreddits)) {
    if (typeof s?.name !== "string" || !SUBREDDIT.test(s.name) || s.name.toLowerCase() !== key) continue;
    if (!isTime(s.posts_to_utc) || !isTime(s.comments_to_utc)) continue;
    if (Math.max(s.posts_to_utc, s.comments_to_utc) > now + CLOCK_SLACK) continue;
    const files = {};
    for (const [kind, name] of Object.entries(FILES)) {
      const f = s.files?.[name];
      if (typeof f?.path === "string" && FILE_PATH.test(f.path) && f.path.startsWith(`r/${key}/`) &&
        Number.isSafeInteger(f.bytes) && f.bytes > 0) {
        files[kind] = { path: f.path, bytes: f.bytes };
      }
    }
    if (!files.posts || !files.comments) continue;
    const link = s.files?.[LINK_FILE];
    if (typeof link?.path === "string" && FILE_PATH.test(link.path) && link.path.startsWith(`r/${key}/`) &&
      Number.isSafeInteger(link.bytes) && link.bytes > 0) {
      files.link = { path: link.path, bytes: link.bytes };
    }
    subs.set(key, {
      name: s.name,
      postsThrough: s.posts_to_utc - INGEST_LAG,
      commentsThrough: s.comments_to_utc - INGEST_LAG,
      files,
    });
  }
  return subs;
}

// Activity in covered subreddits after their files end, fetched by core.js's fetchTails once
// per scan rather than once per commenter, and kept for the tab so the next scan asks only
// for what's new. Per subreddit and kind: the files' cutoff it follows (`base`; a new build
// starts afresh), how far it's complete (`through`), the ids seen (to drop repeats), and each
// author's times.
export class TailStore {
  constructor() {
    this._tails = new Map(); // "kind|sub" -> {base, through, ids, times}
  }

  // The tail following files trusted to `base`, or null.
  find(kind, key, base) {
    const t = this._tails.get(`${kind}|${key}`);
    return t?.base === base ? t : null;
  }

  // The tail following files trusted to `base`, started afresh if there's none yet or it
  // followed an older build.
  open(kind, key, base) {
    let t = this.find(kind, key, base);
    if (!t) {
      t = { base, through: base, ids: new Set(), times: new Map() };
      this._tails.set(`${kind}|${key}`, t);
    }
    return t;
  }
}

export class DumpSource {
  constructor(subs, {
    baseUrl = DUMPS_URL, openFile = urlFile, signal = null, readTimeoutMs = 20000,
    fetchFn = (...a) => globalThis.fetch(...a), onRequest = null, tails = new TailStore(),
  } = {}) {
    this.baseUrl = baseUrl;
    this.signal = signal;
    this.broken = false; // a read failed: leave the files alone for the rest of the scan
    this.reads = 0; // successful timestamps() calls, for the end-of-scan note
    this.threadReads = 0; // successful threadRows() calls, likewise
    this.lifetimeReads = 0; // times core.js's archiveLifetime answered, for the end-of-scan note
    this.readTimeoutMs = readTimeoutMs;
    this._subs = subs;
    this._openFile = openFile;
    this._fetchFn = fetchFn;
    this._onRequest = onRequest; // called once per request sent to the archive server
    this._files = new Map(); // path -> Promise<{file, metadata}>
    this._lookups = new Map(); // "kind|sub|author" -> Promise<number[]>, for this scan
    this._tails = tails;
  }

  // The archive, or null if there's no usable manifest (missing, unreachable, slow,
  // malformed, or covering nothing). Throws Aborted only when `signal` aborts.
  // `onRequest` is called once per request sent to the archive server, the manifest's
  // included (even when it leads to null), so the page can count them.
  // `tails` is the tab's TailStore, so a scan picks up where the last one's tail ended.
  // `onRequest` gets each request's URL.
  static async open({
    baseUrl = DUMPS_URL, fetchFn = (...a) => globalThis.fetch(...a), openFile = urlFile,
    signal = null, timeoutMs = 5000, readTimeoutMs = 20000, onRequest = null, tails = new TailStore(),
  } = {}) {
    if (signal?.aborted) throw new Aborted("stopped");
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      onRequest?.(`${baseUrl}/manifest.json`);
      const resp = await fetchFn(`${baseUrl}/manifest.json`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!resp.ok) return null;
      const subs = parseManifest(await resp.json());
      return subs.size ? new DumpSource(subs, { baseUrl, openFile, signal, readTimeoutMs, fetchFn, onRequest, tails }) : null;
    } catch {
      if (signal?.aborted) throw new Aborted("stopped");
      return null;
    }
  }

  // Races `promise` against `readTimeoutMs` (never resolving early on success). Used
  // around each range read so a stalled or never-settling read can't stall a caller
  // forever; a swallow-handler keeps a late rejection from the loser from surfacing as an
  // unhandled rejection.
  _race(promise) {
    promise.catch(() => {});
    if (!this.readTimeoutMs) return promise;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`archive read timed out after ${this.readTimeoutMs}ms`)), this.readTimeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // {name, postsThrough, commentsThrough} for a covered subreddit (any case), else null.
  // Each kind is covered to where its files end, or further if its tail got further (unless
  // `withTail` is false).
  covers(subreddit, { withTail = true } = {}) {
    if (this.broken) return null;
    const key = String(subreddit).toLowerCase();
    const s = this._subs.get(key);
    if (!s) return null;
    const through = (kind) => (withTail && this._tails.find(kind, key, filesThrough(s, kind))?.through) || filesThrough(s, kind);
    return { name: s.name, postsThrough: through("posts"), commentsThrough: through("comments") };
  }

  // Where a covered subreddit's next tail fetch starts (`after`, exclusive): where the files
  // end, or an hour before the tab's tail was complete to, in case its newest rows were
  // archived late (the rows fetched again are dropped by id).
  tailFrom(kind, subreddit) {
    const key = String(subreddit).toLowerCase();
    const base = filesThrough(this._subs.get(key), kind);
    const t = this._tails.find(kind, key, base);
    return t && t.through > base ? Math.max(base, t.through - INGEST_LAG) : base;
  }

  // Adds a page of fetched rows ({id, author, created_utc}) to a subreddit's tail.
  // The API's rows are untrusted: ones without an id, author or time, by the accounts the
  // archive leaves out, from before the files end, dated more than a day past `now` (epoch
  // seconds, as a manifest's cutoffs are checked), or already seen are dropped.
  addTail(kind, subreddit, rows, { now = Date.now() / 1000 } = {}) {
    const key = String(subreddit).toLowerCase();
    const t = this._tails.open(kind, key, filesThrough(this._subs.get(key), kind));
    for (const row of rows) {
      const id = row?.id;
      const author = row?.author;
      const time = Math.trunc(Number(row?.created_utc));
      if (typeof id !== "string" || !id || t.ids.has(id) || typeof author !== "string" || !author) continue;
      if (SKIPPED.has(author.toLowerCase()) || !isTime(time) || time <= t.base || time > now + CLOCK_SLACK) continue;
      t.ids.add(id);
      const times = t.times.get(author.toLowerCase());
      if (times) times.push(time);
      else t.times.set(author.toLowerCase(), [time]);
    }
  }

  // Records how far a subreddit's tail is complete (`through`, epoch seconds; it never moves
  // back).
  endTail(kind, subreddit, { through }) {
    const key = String(subreddit).toLowerCase();
    const t = this._tails.open(kind, key, filesThrough(this._subs.get(key), kind));
    if (through > t.through) t.through = through;
  }

  // Creation times (epoch seconds, oldest first) of every post or comment `author` has in
  // the subreddit's files, and in its tail: once there's a tail, the files count only up to
  // where they're trusted, since the tail fetched what's after that again. Throws Aborted
  // once stopped, else DumpUnavailable. A lookup is read once per source (one scan) and
  // shared; callers must not change the array.
  timestamps(kind, subreddit, author) {
    const key = `${kind}|${String(subreddit).toLowerCase()}|${String(author).toLowerCase()}`;
    let lookup = this._lookups.get(key);
    if (!lookup) {
      lookup = this._read(kind, subreddit, author);
      lookup.catch(() => this._lookups.delete(key));
      this._lookups.set(key, lookup);
    }
    return lookup;
  }

  // Internal method that actually reads from the archive.
  async _read(kind, subreddit, author) {
    const key = String(subreddit).toLowerCase();
    const s = this._subs.get(key);
    const f = s?.files[kind];
    if (!f || this.broken) throw new DumpUnavailable(`no usable ${kind} file for r/${subreddit}`);
    const tail = this._tails.find(kind, key, filesThrough(s, kind));
    try {
      const { file, metadata } = await this._race(this._open(f));
      // $eq, not a plain value: only operator filters let hyparquet skip row groups by
      // their author range, so a lookup reads one ~100 KB group, not the whole file.
      const rows = await this._race(parquetQuery({
        file, metadata, columns: ["author", "created_utc"], filter: { author: { $eq: String(author).toLowerCase() } },
      }));
      this.reads++;
      const saved = rows.map((r) => Number(r.created_utc)).filter(isTime);
      if (!tail) return saved.sort((a, b) => a - b);
      const recent = tail.times.get(String(author).toLowerCase()) ?? [];
      return [...saved.filter((t) => t <= tail.base), ...recent].sort((a, b) => a - b);
    } catch (err) {
      if (this.signal?.aborted) throw new Aborted("stopped");
      this.broken = true;
      throw new DumpUnavailable(`archive file ${f.path}: ${err?.message ?? err}`);
    }
  }

  // The comments under post `linkId` ({author, created_utc}, author as written) in the
  // subreddit's comments_by_link file, up to where the files are trusted (`covers(…,
  // {withTail: false}).commentsThrough`); the caller asks the API for the rest. Throws
  // Aborted once stopped, else DumpUnavailable: when there's no such file, or when it can't
  // be read, which switches the source off like any failed read.
  async threadRows(subreddit, linkId) {
    const key = String(subreddit).toLowerCase();
    const s = this._subs.get(key);
    const f = s?.files.link;
    if (!f || this.broken) throw new DumpUnavailable(`no usable thread file for r/${subreddit}`);
    try {
      const { file, metadata } = await this._race(this._open(f));
      const rows = await this._race(parquetQuery({
        file, metadata, columns: ["link_id", "author", "created_utc"], filter: { link_id: { $eq: String(linkId) } },
      }));
      this.threadReads++;
      const saved = rows
        .map((r) => ({ author: r.author, created_utc: Number(r.created_utc) }))
        .filter((r) => typeof r.author === "string" && r.author && isTime(r.created_utc) && r.created_utc <= s.commentsThrough);
      return saved;
    } catch (err) {
      if (this.signal?.aborted) throw new Aborted("stopped");
      this.broken = true;
      throw new DumpUnavailable(`archive file ${f.path}: ${err?.message ?? err}`);
    }
  }

  // A file and its footer, fetched once per source. A failed open here is retried next
  // time, but `timestamps` only calls this again after a Stop (Aborted): any other
  // failure, including a read timing out, sets `broken` first and shuts the source off.
  _open(f) {
    let opened = this._files.get(f.path);
    if (!opened) {
      opened = (async () => {
        const file = await this._openFile(`${this.baseUrl}/${f.path}`, f.bytes, this.signal, this.readTimeoutMs, {
          fetchFn: this._fetchFn, onRequest: this._onRequest,
        });
        // The footer is a few KB; hyparquet's default first read is the last 512 KB.
        return { file, metadata: await parquetMetadataAsync(file, { initialFetchSize: 64 * 1024 }) };
      })();
      opened.catch(() => this._files.delete(f.path));
      this._files.set(f.path, opened);
    }
    return opened;
  }
}
