// Archive files for covered subreddits (built by tools/build_dumps.py and served from R2):
// each author's posts and comments in the subreddit, read with range requests, so the
// "before" facts need no Arctic Shift searches. See CLAUDE.md, "Subreddit dumps".

import { Aborted, INGEST_LAG } from "./core.js";
import { asyncBufferFromUrl, cachedAsyncBuffer, parquetMetadataAsync, parquetQuery } from "./hyparquet.js";

export const DUMPS_URL = "https://rpp-db.tinted979.dev";
// The manifest format this page reads (FORMAT in tools/build_dumps.py).
export const DUMP_FORMAT = 1;
// The file for each kind, as named in the manifest.
const FILES = { posts: "posts_by_author", comments: "comments_by_author" };
// Where a manifest may point: r/<subreddit>/<version>/<name>.parquet under the base URL.
const FILE_PATH = /^r\/\w{2,21}\/\w[\w.-]{0,39}\/\w+\.parquet$/;
const isTime = (n) => Number.isSafeInteger(n) && n > 0;
// A subreddit name, as Reddit allows them.
const SUBREDDIT = /^\w{2,21}$/;
// How far past the page's clock a manifest's cutoffs may be (clock skew), in seconds.
const CLOCK_SLACK = 86400;

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
    onRequest?.();
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
    subs.set(key, {
      name: s.name,
      postsThrough: s.posts_to_utc - INGEST_LAG,
      commentsThrough: s.comments_to_utc - INGEST_LAG,
      files,
    });
  }
  return subs;
}

export class DumpSource {
  constructor(subs, {
    baseUrl = DUMPS_URL, openFile = urlFile, signal = null, readTimeoutMs = 20000,
    fetchFn = (...a) => globalThis.fetch(...a), onRequest = null,
  } = {}) {
    this.baseUrl = baseUrl;
    this.signal = signal;
    this.broken = false; // a read failed: leave the files alone for the rest of the scan
    this.reads = 0; // successful timestamps() calls, for the end-of-scan note
    this.lifetimeReads = 0; // times core.js's archiveLifetime answered, for the end-of-scan note
    this.readTimeoutMs = readTimeoutMs;
    this._subs = subs;
    this._openFile = openFile;
    this._fetchFn = fetchFn;
    this._onRequest = onRequest; // called once per request sent to the archive server
    this._files = new Map(); // path -> Promise<{file, metadata}>
    this._lookups = new Map(); // "kind|sub|author" -> Promise<number[]>, for this scan
  }

  // The archive, or null if there's no usable manifest (missing, unreachable, slow,
  // malformed, or covering nothing). Throws Aborted only when `signal` aborts.
  // `onRequest` is called once per request sent to the archive server, the manifest's
  // included (even when it leads to null), so the page can count them.
  static async open({
    baseUrl = DUMPS_URL, fetchFn = (...a) => globalThis.fetch(...a), openFile = urlFile,
    signal = null, timeoutMs = 5000, readTimeoutMs = 20000, onRequest = null,
  } = {}) {
    if (signal?.aborted) throw new Aborted("stopped");
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      onRequest?.();
      const resp = await fetchFn(`${baseUrl}/manifest.json`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!resp.ok) return null;
      const subs = parseManifest(await resp.json());
      return subs.size ? new DumpSource(subs, { baseUrl, openFile, signal, readTimeoutMs, fetchFn, onRequest }) : null;
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
  covers(subreddit) {
    if (this.broken) return null;
    const s = this._subs.get(String(subreddit).toLowerCase());
    return s ? { name: s.name, postsThrough: s.postsThrough, commentsThrough: s.commentsThrough } : null;
  }

  // Creation times (epoch seconds, oldest first) of every post or comment `author` has in
  // the subreddit's files. Throws Aborted once stopped, else DumpUnavailable. A lookup is
  // read once per source (one scan) and shared; callers must not change the array.
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
    const f = this._subs.get(String(subreddit).toLowerCase())?.files[kind];
    if (!f || this.broken) throw new DumpUnavailable(`no usable ${kind} file for r/${subreddit}`);
    try {
      const { file, metadata } = await this._race(this._open(f));
      // $eq, not a plain value: only operator filters let hyparquet skip row groups by
      // their author range, so a lookup reads one ~100 KB group, not the whole file.
      const rows = await this._race(parquetQuery({
        file, metadata, columns: ["author", "created_utc"], filter: { author: { $eq: String(author).toLowerCase() } },
      }));
      this.reads++;
      return rows.map((r) => Number(r.created_utc)).filter(isTime).sort((a, b) => a - b);
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
