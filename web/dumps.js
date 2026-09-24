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

// The archive files can't answer (a network error, a bad file). Callers use the API.
export class DumpUnavailable extends Error {}

// Reads a remote file with range requests, keeping what it has fetched.
async function urlFile(url, byteLength, signal) {
  return cachedAsyncBuffer(await asyncBufferFromUrl({ url, byteLength, requestInit: { signal: signal ?? undefined } }));
}

// The covered subreddits in a manifest, keyed by lowercase name. The manifest is fetched,
// so it's checked like any other untrusted input; anything that doesn't check out is left
// out. `postsThrough`/`commentsThrough` are where the files can be trusted to: an hour
// before their newest item, in case the newest were archived late.
export function parseManifest(data) {
  const subs = new Map();
  if (data?.format !== DUMP_FORMAT || !data.subreddits || typeof data.subreddits !== "object") return subs;
  for (const [key, s] of Object.entries(data.subreddits)) {
    if (typeof s?.name !== "string" || s.name.toLowerCase() !== key) continue;
    if (!isTime(s.posts_to_utc) || !isTime(s.comments_to_utc)) continue;
    const files = {};
    for (const [kind, name] of Object.entries(FILES)) {
      const f = s.files?.[name];
      if (typeof f?.path === "string" && FILE_PATH.test(f.path) && Number.isSafeInteger(f.bytes) && f.bytes > 0) {
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
  constructor(subs, { baseUrl = DUMPS_URL, openFile = urlFile, signal = null } = {}) {
    this.baseUrl = baseUrl;
    this.signal = signal;
    this.broken = false; // a read failed: leave the files alone for the rest of the scan
    this._subs = subs;
    this._openFile = openFile;
    this._files = new Map(); // path -> Promise<{file, metadata}>
  }

  // The archive, or null if there's no usable manifest (missing, unreachable, slow,
  // malformed, or covering nothing). Throws Aborted only when `signal` aborts.
  static async open({ baseUrl = DUMPS_URL, fetchFn = (...a) => globalThis.fetch(...a), openFile = urlFile, signal = null, timeoutMs = 5000 } = {}) {
    if (signal?.aborted) throw new Aborted("stopped");
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const resp = await fetchFn(`${baseUrl}/manifest.json`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!resp.ok) return null;
      const subs = parseManifest(await resp.json());
      return subs.size ? new DumpSource(subs, { baseUrl, openFile, signal }) : null;
    } catch {
      if (signal?.aborted) throw new Aborted("stopped");
      return null;
    }
  }

  // {name, postsThrough, commentsThrough} for a covered subreddit (any case), else null.
  covers(subreddit) {
    if (this.broken) return null;
    const s = this._subs.get(String(subreddit).toLowerCase());
    return s ? { name: s.name, postsThrough: s.postsThrough, commentsThrough: s.commentsThrough } : null;
  }

  // Creation times (epoch seconds, oldest first) of every post or comment `author` has in
  // the subreddit's files. Throws Aborted once stopped, else DumpUnavailable.
  async timestamps(kind, subreddit, author) {
    const f = this._subs.get(String(subreddit).toLowerCase())?.files[kind];
    if (!f || this.broken) throw new DumpUnavailable(`no usable ${kind} file for r/${subreddit}`);
    try {
      const { file, metadata } = await this._open(f);
      // $eq, not a plain value: only operator filters let hyparquet skip row groups by
      // their author range, so a lookup reads one ~100 KB group, not the whole file.
      const rows = await parquetQuery({
        file, metadata, columns: ["author", "created_utc"], filter: { author: { $eq: String(author).toLowerCase() } },
      });
      return rows.map((r) => Number(r.created_utc)).filter(isTime).sort((a, b) => a - b);
    } catch (err) {
      if (this.signal?.aborted) throw new Aborted("stopped");
      this.broken = true;
      throw new DumpUnavailable(`archive file ${f.path}: ${err?.message ?? err}`);
    }
  }

  // A file and its footer, fetched once per source (a failed open is retried next time).
  _open(f) {
    let opened = this._files.get(f.path);
    if (!opened) {
      opened = (async () => {
        const file = await this._openFile(`${this.baseUrl}/${f.path}`, f.bytes, this.signal);
        // The footer is a few KB; hyparquet's default first read is the last 512 KB.
        return { file, metadata: await parquetMetadataAsync(file, { initialFetchSize: 64 * 1024 }) };
      })();
      opened.catch(() => this._files.delete(f.path));
      this._files.set(f.path, opened);
    }
    return opened;
  }
}
