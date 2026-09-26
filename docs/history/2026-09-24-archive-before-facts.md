> **History.** This plan was implemented in PR #17 and is kept for the record; it is not current work. Its decision is docs/adr/0004, since superseded by 0005 (a scheduled sync and shared tails) and 0006 (every count stops at the post). For how the code works now, see CLAUDE.md and `.claude/rules/archive.md`.

# Archive "before" facts: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For a post in a subreddit that has archive files on R2 (built by `tools/build_dumps.py`), take each commenter's "before" facts (posts and comments in the subreddit before the post, first date, days active) from those files instead of Arctic Shift searches. Arctic Shift is still asked about any time after the files end, and about everything if the files can't be read.

**Architecture:**
- **`web/dumps.js`** (new): a `DumpSource` that loads `manifest.json` from `https://rpp-db.tinted979.dev`, says which subreddits it covers, and returns one author's timestamps from a Parquet file. It reads with a copy of hyparquet saved in the repo (`web/hyparquet.js`) using HTTP range requests.
- **`beforeFacts` in `core.js`** takes an optional `dumps` source:
  - it uses the files' timestamps up to their end time, less `INGEST_LAG`;
  - it asks the API only for the gap between that end time and the post;
  - it falls back to the current API path whenever the files fail.
- **`app.js`** opens the source once per scan and passes it to `buildProfile`.

**Tech stack:** plain ES modules with no build step; hyparquet 1.31.1 (jsDelivr's bundled `+esm` build, one 64 KB file with no imports, saved as `web/hyparquet.js`); `node --test`.

**Spec:** CLAUDE.md § "Subreddit dumps (in progress)", which covers the file layout, hosting and hyparquet notes, plus the design decisions below.

**Out of scope, as a follow-up:**
- The thread's commenters (`collectCommenters`) keep using the API. That is one request per scan, not per user, and reading them from the files needs its own gap logic, because the files have no comment ids to de-duplicate on.
- Lifetime counts can't come from a single subreddit's files.

## Design decisions

- **Where the files end.** For each kind, `through = <kind>_to_utc − INGEST_LAG` (3600 s). File rows after `through` are ignored, and the API covers `(through, post)`.
  - Arctic Shift's `after` is exclusive (`iterThreadComments` relies on this), so the two ranges can't overlap and nothing is counted twice.
  - Leaving out the last hour guards against items archived late at the end of the download.
- **The post is older than `through`.** Every "before" item is in the files, so the timeline is exact: every timestamp, not just the newest 100, gives `complete: true` and no API request.
- **The post is newer than `through`.** Take the files' part, plus the existing API logic (a timestamp search, and past 100 items an aggregate and an `asc` search) over `after = max(windowStart, through)`. Then:
  - `count` is the sum of the two;
  - `times` joins the two lists;
  - `first` is the files' earliest time, or the gap's if the files have none;
  - `complete` is the gap's `complete`.
- **The history window (`years`)** applies to file rows too: only rows after `after`, since the API's `after` is exclusive.
- **Failures.** If a file read fails (anything except Stop), that user falls back to today's API path for that kind, and the `DumpSource` marks itself `broken`, so later users skip the files entirely. Stop (`Aborted`) always propagates.
- **The manifest is untrusted input**, like any fetched data:
  - `format` must be 1;
  - names and times are checked;
  - file paths must match `r/<sub>/<version>/<name>.parquet`, so the page only ever fetches under the base URL.
- **Nothing stored changes shape.** A "before" record is still `{posts, comments, first, days, complete}`, so the `v2|before|…` cache key stays as it is.

## Global constraints

- No build step and no npm dependencies. `web/hyparquet.js` is a saved copy of a third-party file: never edit it by hand, and update it only by downloading a new version (Task 1 shows how).
- Local imports stay in the form `from "./x.js"`, which the deploy step's cache-busting rewrites.
- `dumps.js` and `hyparquet.js` sit at the top of `web/`, so the deploy step's `cp web/*.js` already copies them.
- API requests still go through `ArcticShiftClient._get`. The gap queries use the existing `client.timestamps`/`client.subredditCounts`.
- Put text on the page with `textContent`/`el()`, never `innerHTML`.
- `cd web && npm test` must pass after every task.
- Git: work on the branch `claude/archive-before-facts`, commit after each task, and open a PR into `main` at the end. Never push to `main`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review focus

The failure modes most likely to affect a real user that no single happy-path test covers, each with its pinning test in the task named:

1. **R2 drops out mid-scan** (network error on a range read). That user must still get correct counts from the API, the scan must not fail, and later users must skip the files. *Task 2 test "a failed read…", Task 3 test "if the archive fails…".*
2. **A post just after the files end** counts the items near the boundary once, not twice or zero times. *Task 3 test "a post newer than the files…".*
3. **Stop during a file read** stops the scan. It must not fall back to the API and keep requesting. *Task 2 test "Stop during a read…", Task 3 test "Stop while reading…".*
4. **Usernames in any case** ("Alice" in the thread, "alice" in the files) find the same rows. *Task 2 test "timestamps finds an author in any case".*
5. **A very active user** with 150,000+ items in the subreddit must not crash with `RangeError` from `Math.min(...arr)`. *Task 3 test "tens of thousands of items…".*

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `web/hyparquet.js` | Create (saved copy) | Parquet reading. Third-party, MIT. |
| `web/dumps.js` | Create | Manifest loading and checking, coverage, per-author timestamp lookups, failure and Stop handling. |
| `web/core.js` | Modify: export `INGEST_LAG`; `beforeFacts` and `buildProfile` take `dumps` | Merging file and API "before" facts. |
| `web/app.js` | Modify: `run()` | Open the source per scan, pass it through, report use in the status. |
| `web/tests/fixtures/dumps-src/*.jsonl` | Create | Tiny source dumps for the fixtures. |
| `web/tests/fixtures/dumps/**` | Create (generated) | Fixture `manifest.json` and Parquet files, built by `tools/build_dumps.py`. |
| `web/tests/dumps.test.js` | Create | Tests for `dumps.js` against the fixtures. |
| `web/tests/core.test.js` | Modify | Tests for `beforeFacts` with a fake dump source. |
| `.gitattributes` | Modify | Mark `*.parquet` as binary. |
| `CLAUDE.md`, `README.md` | Modify | Architecture, the section on subreddit dumps, and how it works. |

---

### Task 1: Save hyparquet in the repo and build test fixtures

**Files:**
- Create: `web/hyparquet.js`, `web/tests/fixtures/dumps-src/posts.jsonl`, `web/tests/fixtures/dumps-src/comments.jsonl`, `web/tests/fixtures/dumps/**` (generated), `web/tests/dumps.test.js`
- Modify: `.gitattributes`

**Interfaces:**
- Produces: `web/hyparquet.js`, exporting `asyncBufferFromUrl`, `cachedAsyncBuffer`, `parquetMetadataAsync`, `parquetQuery` (and the rest of hyparquet's API); and fixture files at `web/tests/fixtures/dumps/manifest.json` and `web/tests/fixtures/dumps/r/python/v1/{posts_by_author,comments_by_author,comments_by_link}.parquet`.

- [ ] **Step 1: Create the branch**

```bash
git switch main && git pull --ff-only && git switch -c claude/archive-before-facts
```

- [ ] **Step 2: Download hyparquet's bundled build with its licence on top**

```bash
cd web
{ echo "/*! hyparquet 1.31.1 (https://github.com/hyparam/hyparquet), jsDelivr +esm build."
  echo "    Saved copy: don't edit. To update, download a new version the same way."
  curl -s https://cdn.jsdelivr.net/npm/hyparquet@1.31.1/LICENSE | sed 's/^/    /'
  echo "*/"
  curl -s https://cdn.jsdelivr.net/npm/hyparquet@1.31.1/+esm | grep -v '^//# sourceMappingURL='
} > hyparquet.js
head -c 600 hyparquet.js; grep -c 'export{' hyparquet.js
```

Expected: a comment block with the MIT licence text, then the bundle, and `1`. Check it has no imports of its own: `grep -cE '(^|[;}])import |from "' hyparquet.js` should print `0`.

- [ ] **Step 3: Write the fixture source dumps**

`web/tests/fixtures/dumps-src/posts.jsonl`:

```
{"id":"p1","author":"Alice","created_utc":1699900000,"subreddit":"Python"}
{"id":"p2","author":"bob","created_utc":1699950000,"subreddit":"Python"}
{"id":"p3","author":"[deleted]","created_utc":1699960000,"subreddit":"Python"}
```

`web/tests/fixtures/dumps-src/comments.jsonl`:

```
{"id":"c1","author":"Alice","created_utc":1699500000,"subreddit":"Python","link_id":"t3_p0"}
{"id":"c2","author":"alice","created_utc":1698000000,"subreddit":"Python","link_id":"t3_p0"}
{"id":"c3","author":"Alice","created_utc":1699000000,"subreddit":"Python","link_id":"t3_p1"}
{"id":"c4","author":"carol","created_utc":1699990000,"subreddit":"Python","link_id":"t3_p1"}
```

So the build's `posts_to_utc` is 1699950000 and `comments_to_utc` is 1699990000.

- [ ] **Step 4: Build the fixtures and mark Parquet as binary**

```bash
cd ..   # repo root
uv run tools/build_dumps.py --subreddit Python \
  --posts web/tests/fixtures/dumps-src/posts.jsonl --comments web/tests/fixtures/dumps-src/comments.jsonl \
  --out web/tests/fixtures/dumps --version v1
printf '*.parquet binary\n' >> .gitattributes
```

Expected: `posts: 3 read, 2 kept …`, `comments: 4 read, 4 kept …`, and `web/tests/fixtures/dumps/r/python/v1/` holding three `.parquet` files.

- [ ] **Step 5: Write a smoke test that hyparquet reads the fixtures**

Create `web/tests/dumps.test.js`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parquetMetadataAsync, parquetQuery } from "../hyparquet.js";

const FIX = new URL("./fixtures/dumps/", import.meta.url);

// A local file as hyparquet's AsyncBuffer (what range requests give in the browser).
function localBuffer(relPath) {
  const buf = readFileSync(new URL(relPath, FIX));
  return { byteLength: buf.byteLength, slice: (s, e = buf.byteLength) => buf.buffer.slice(buf.byteOffset + s, buf.byteOffset + e) };
}

test("the saved hyparquet reads the build script's Snappy Parquet", async () => {
  const file = localBuffer("r/python/v1/comments_by_author.parquet");
  const metadata = await parquetMetadataAsync(file);
  const rows = await parquetQuery({ file, metadata, columns: ["author", "created_utc"], filter: { author: { $eq: "alice" } } });
  assert.deepEqual(rows.map((r) => Number(r.created_utc)), [1698000000, 1699000000, 1699500000]);
});
```

- [ ] **Step 6: Run it**

Run: `cd web && node --test tests/dumps.test.js`
Expected: PASS (1 test). Then `npm test`: all pass.

- [ ] **Step 7: Commit**

```bash
git add web/hyparquet.js web/tests/fixtures web/tests/dumps.test.js .gitattributes
git commit -m "Save hyparquet in the repo and add archive test fixtures

hyparquet 1.31.1's bundled build (one file, no imports, MIT) reads the
archive Parquet files in the browser with range requests. The fixtures
are built by tools/build_dumps.py from the tiny JSONL beside them.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `web/dumps.js`, the `DumpSource`

**Files:**
- Create: `web/dumps.js`
- Modify: `web/core.js` (export `INGEST_LAG`)
- Test: `web/tests/dumps.test.js`

**Interfaces:**
- Consumes: `Aborted` and `INGEST_LAG` from `./core.js` (change `const INGEST_LAG = 3600;` to `export const INGEST_LAG = 3600;`); hyparquet from `./hyparquet.js`.
- Produces:
  - `DUMPS_URL: string` (`"https://rpp-db.tinted979.dev"`), `DUMP_FORMAT: 1`, `class DumpUnavailable extends Error`.
  - `parseManifest(data: unknown): Map<string, {name, postsThrough, commentsThrough, files: {posts: {path, bytes}, comments: {path, bytes}}}>`, keyed by lowercase subreddit.
  - `class DumpSource`:
    - `static open({ baseUrl?, fetchFn?, openFile?, signal?, timeoutMs? }) → Promise<DumpSource | null>`. Resolves `null` if the manifest is missing, broken or covers nothing; throws `Aborted` only if `signal` aborted.
    - `covers(subreddit: string) → {name, postsThrough, commentsThrough} | null` (`null` once `broken`).
    - `timestamps(kind: "posts" | "comments", subreddit: string, author: string) → Promise<number[]>`: epoch seconds, ascending, every item that author has in the files. Throws `Aborted` if stopped, otherwise `DumpUnavailable`, after which `broken` is `true`.
    - `broken: boolean`.
  - `openFile(url, byteLength, signal) → Promise<AsyncBuffer>` is the injection point for tests.

- [ ] **Step 1: Write the failing tests** (append to `web/tests/dumps.test.js`)

```js
import { Aborted, INGEST_LAG } from "../core.js";
import { DUMP_FORMAT, DumpSource, DumpUnavailable, parseManifest } from "../dumps.js";

const BASE = "https://dumps.test";
const MANIFEST = JSON.parse(readFileSync(new URL("manifest.json", FIX), "utf8"));
const localFile = async (url) => localBuffer(url.slice(BASE.length + 1));
const serve = (body, status = 200) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const openFixtures = (opts = {}) => DumpSource.open({ baseUrl: BASE, fetchFn: serve(MANIFEST), openFile: localFile, ...opts });

test("open reads the manifest; covers matches any case and ends an hour early", async () => {
  const dumps = await openFixtures();
  const expected = { name: "Python", postsThrough: 1699950000 - INGEST_LAG, commentsThrough: 1699990000 - INGEST_LAG };
  assert.deepEqual(dumps.covers("python"), expected);
  assert.deepEqual(dumps.covers("PYTHON"), expected);
  assert.equal(dumps.covers("rust"), null);
});

test("timestamps finds an author in any case, oldest first", async () => {
  const dumps = await openFixtures();
  assert.deepEqual(await dumps.timestamps("comments", "Python", "ALICE"), [1698000000, 1699000000, 1699500000]);
  assert.deepEqual(await dumps.timestamps("posts", "python", "Alice"), [1699900000]);
  assert.deepEqual(await dumps.timestamps("posts", "Python", "nobody"), []);
});

test("each file is opened once per source", async () => {
  let opens = 0;
  const dumps = await openFixtures({ openFile: async (url) => (opens++, localFile(url)) });
  await Promise.all([dumps.timestamps("comments", "Python", "alice"), dumps.timestamps("comments", "Python", "carol")]);
  await dumps.timestamps("posts", "Python", "bob");
  assert.equal(opens, 2);
});

test("a failed read throws DumpUnavailable and switches the source off", async () => {
  const dumps = await openFixtures({ openFile: async () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(dumps.timestamps("comments", "Python", "alice"), DumpUnavailable);
  assert.equal(dumps.broken, true);
  assert.equal(dumps.covers("Python"), null);
  await assert.rejects(dumps.timestamps("posts", "Python", "alice"), DumpUnavailable);
});

test("Stop during a read throws Aborted and leaves the source usable", async () => {
  const controller = new AbortController();
  const dumps = await openFixtures({
    signal: controller.signal,
    openFile: async () => { controller.abort(); throw new DOMException("aborted", "AbortError"); },
  });
  await assert.rejects(dumps.timestamps("comments", "Python", "alice"), Aborted);
  assert.equal(dumps.broken, false);
});

test("open gives null when there's no usable manifest", async () => {
  const open = (fetchFn) => DumpSource.open({ baseUrl: BASE, fetchFn, openFile: localFile });
  assert.equal(await open(serve("not found", 404)), null);
  assert.equal(await open(serve("{not json")), null);
  assert.equal(await open(async () => { throw new TypeError("Failed to fetch"); }), null);
  assert.equal(await open(serve({ ...MANIFEST, format: DUMP_FORMAT + 1 })), null);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(DumpSource.open({ baseUrl: BASE, fetchFn: serve(MANIFEST), signal: controller.signal }), Aborted);
});

test("parseManifest leaves out subreddits it can't trust", () => {
  const sub = MANIFEST.subreddits.python;
  const withFile = (name, change) => ({
    format: DUMP_FORMAT,
    subreddits: { python: { ...sub, files: { ...sub.files, [name]: { ...sub.files[name], ...change } } } },
  });
  assert.equal(parseManifest(MANIFEST).size, 1);
  for (const path of ["../secret.parquet", "https://evil.example/x.parquet", "r/python/v1/x.json", "r/python/../../x.parquet"]) {
    assert.equal(parseManifest(withFile("posts_by_author", { path })).size, 0, path);
  }
  assert.equal(parseManifest(withFile("comments_by_author", { bytes: -1 })).size, 0);
  assert.equal(parseManifest({ format: DUMP_FORMAT, subreddits: { rust: sub } }).size, 0); // key must match the name
  assert.equal(parseManifest({ format: DUMP_FORMAT, subreddits: { python: { ...sub, posts_to_utc: "soon" } } }).size, 0);
  assert.equal(parseManifest(null).size, 0);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd web && node --test tests/dumps.test.js`
Expected: FAIL: `Cannot find module '…/dumps.js'`, or `INGEST_LAG` not exported.

- [ ] **Step 3: Export `INGEST_LAG`**

In `web/core.js`, change `const INGEST_LAG = 3600;` to `export const INGEST_LAG = 3600;`.

- [ ] **Step 4: Write `web/dumps.js`**

```js
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
```

- [ ] **Step 5: Run the tests**

Run: `cd web && node --test tests/dumps.test.js`
Expected: PASS (8 tests). Then `npm test`: all pass.

- [ ] **Step 6: Commit**

```bash
git add web/dumps.js web/core.js web/tests/dumps.test.js
git commit -m "Add DumpSource: per-author timestamps from the archive files

It loads the archive's manifest (checked as untrusted input; paths must
stay under the base URL), says which subreddits it covers, and reads
one author's items from a Parquet file with range requests. A failed
read switches the source off for the rest of the scan; Stop throws
Aborted.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: "Before" facts from the archive in `core.js`

**Files:**
- Modify: `web/core.js` (`beforeFacts`, `buildProfile`, a new `minOf` helper)
- Test: `web/tests/core.test.js`

**Interfaces:**
- Consumes: any object with the `DumpSource` shape from Task 2: `covers(subreddit)` and `timestamps(kind, subreddit, author)`. `core.js` must **not** import `dumps.js`, which imports `core.js`; it only calls the methods. Any error from `timestamps` other than `Aborted` means "use the API".
- Produces: `buildProfile(client, username, threadComments, post, { only, after, lastCommentUtc, cache, dumps = null })`. The profile fields are the same as today.

- [ ] **Step 1: Write the failing tests** (append to `web/tests/core.test.js`; `POST` is r/Python, created 1_700_000_000)

```js
// A stand-in for dumps.js's DumpSource: `times[kind][lowercase author]`, covering r/Python
// with the given trust times. Records reads; `fail` makes reads throw like a network error.
function fakeDumps({ postsThrough, commentsThrough, times = {}, fail = null }) {
  const reads = [];
  return {
    reads,
    covers: (sub) => (sub.toLowerCase() === "python" ? { name: "Python", postsThrough, commentsThrough } : null),
    timestamps: async (kind, sub, author) => {
      reads.push([kind, sub, author]);
      if (fail) throw fail;
      return times[kind]?.[author.toLowerCase()] ?? [];
    },
  };
}

// Lifetime aggregates (all in `sub`), and "before" searches honouring after/before/sort/limit.
function apiWithBefore({ comments = 0, posts = 0, before = {}, sub = "Python" }) {
  return (u) => {
    const kind = u.pathname.includes("/posts/") ? "posts" : "comments";
    if (!u.searchParams.has("subreddit")) {
      const n = kind === "posts" ? posts : comments;
      return json({ data: n ? [{ key: sub, count: String(n) }] : [] });
    }
    const after = Number(u.searchParams.get("after") ?? -Infinity);
    const beforeTs = Number(u.searchParams.get("before") ?? Infinity);
    const times = (before[kind] ?? []).filter((t) => t > after && t < beforeTs);
    if (u.pathname.endsWith("/aggregate")) return json({ data: [{ key: sub, count: String(times.length) }] });
    return searchTimes(u, times);
  };
}

const T = POST.createdUtc;

test("with archive files past the post, before facts come from them with no searches", async () => {
  const { client, calls } = makeClient(apiWithBefore({ comments: 10, posts: 3 }));
  const dumps = fakeDumps({
    postsThrough: T + 86400, commentsThrough: T + 86400,
    times: {
      comments: { alice: [T - 30 * 86400, T - 2 * 86400, T - 2 * 86400 + 60, T + 100] }, // the last is after the post
      posts: { alice: [T - 10 * 86400] },
    },
  });
  const p = await buildProfile(client, "Alice", 1, POST, { dumps });
  assert.equal(calls.filter((u) => u.searchParams.has("before")).length, 0);
  assert.deepEqual([p.targetPostsBefore, p.targetCommentsBefore], [1, 3]);
  assert.equal(p.targetFirstBefore, T - 30 * 86400);
  assert.equal(p.targetDaysBefore, 3);
  assert.equal(p.targetTimelineComplete, true);
  assert.deepEqual(dumps.reads.map((r) => r[0]).sort(), ["comments", "posts"]);
});

test("the archive gives the whole timeline, not just the newest 100", async () => {
  const many = daily(250);
  const { client } = makeClient(apiWithBefore({ comments: 300 }));
  const dumps = fakeDumps({ postsThrough: T, commentsThrough: T, times: { comments: { alice: many } } });
  const p = await buildProfile(client, "alice", 1, POST, { dumps });
  assert.equal(p.targetCommentsBefore, 250);
  assert.equal(p.targetDaysBefore, 250);
  assert.equal(p.targetTimelineComplete, true);
});

test("a post newer than the files adds the API's gap after them, counting the edge once", async () => {
  const through = T - 5 * 86400;
  const fileTimes = [T - 20 * 86400, through]; // `through` itself is still the files'
  const apiTimes = [through, through + 1, T - 86400]; // the API only answers after `through`
  const { client, calls } = makeClient(apiWithBefore({ comments: 9, before: { comments: [...fileTimes, ...apiTimes] } }));
  const dumps = fakeDumps({ postsThrough: T, commentsThrough: through, times: { comments: { alice: fileTimes } } });
  const p = await buildProfile(client, "alice", 1, POST, { dumps });
  const gap = calls.filter((u) => u.searchParams.has("before"));
  assert.equal(gap.length, 1);
  assert.equal(gap[0].searchParams.get("after"), String(through));
  assert.equal(p.targetCommentsBefore, 4); // 2 from the files + (through + 1) and (T − 1 day)
  assert.equal(p.targetFirstBefore, T - 20 * 86400);
  assert.equal(p.targetTimelineComplete, true);
});

test("the history window applies to archive rows too", async () => {
  const after = T - 10 * 86400;
  const { client } = makeClient(apiWithBefore({ comments: 5 }));
  const dumps = fakeDumps({ postsThrough: T, commentsThrough: T, times: { comments: { alice: [T - 40 * 86400, after, after + 1, T - 1] } } });
  const p = await buildProfile(client, "alice", 1, POST, { dumps, after });
  assert.equal(p.targetCommentsBefore, 2); // `after` is exclusive, like the API's
  assert.equal(p.targetFirstBefore, after + 1);
});

test("if the archive fails, that user's before facts come from the API as before", async () => {
  const apiTimes = [T - 3 * 86400, T - 86400];
  const { client, calls } = makeClient(apiWithBefore({ comments: 4, before: { comments: apiTimes } }));
  const dumps = fakeDumps({ postsThrough: T, commentsThrough: T, fail: new Error("Failed to fetch") });
  const p = await buildProfile(client, "alice", 1, POST, { dumps });
  assert.equal(p.error, null);
  assert.equal(p.targetCommentsBefore, 2);
  const search = calls.find((u) => u.pathname === "/api/comments/search");
  assert.equal(search.searchParams.get("after"), null); // the whole history, not just a gap
});

test("Stop while reading the archive stops the profile", async () => {
  const { client, calls } = makeClient(apiWithBefore({ comments: 4 }));
  const dumps = fakeDumps({ postsThrough: T, commentsThrough: T, fail: new Aborted("stopped") });
  await assert.rejects(buildProfile(client, "alice", 1, POST, { dumps }), Aborted);
  assert.equal(calls.filter((u) => u.searchParams.has("before")).length, 0);
});

test("a subreddit the archive doesn't cover uses the API", async () => {
  const { client, calls } = makeClient(apiWithBefore({ comments: 3, before: { comments: [T - 86400] }, sub: "rust" }));
  const dumps = fakeDumps({ postsThrough: T, commentsThrough: T });
  const p = await buildProfile(client, "alice", 1, { ...POST, subreddit: "rust" }, { dumps });
  assert.equal(dumps.reads.length, 0);
  assert.ok(calls.some((u) => u.pathname === "/api/comments/search"));
  assert.equal(p.targetCommentsBefore, 1);
});

test("tens of thousands of items don't overflow the stack", async () => {
  const many = Array.from({ length: 150_000 }, (_, i) => T - 1 - i * 60);
  const { client } = makeClient(apiWithBefore({ comments: 200_000 }));
  const dumps = fakeDumps({ postsThrough: T, commentsThrough: T, times: { comments: { alice: many } } });
  const p = await buildProfile(client, "alice", 1, POST, { dumps });
  assert.equal(p.targetCommentsBefore, 150_000);
  assert.equal(p.targetFirstBefore, many.at(-1));
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd web && node --test --test-name-pattern="archive|history window|newer than the files|overflow" tests/core.test.js`
Expected: FAIL. `dumps` is ignored, so API searches happen and the counts differ.

- [ ] **Step 3: Add `minOf`** next to `sum` in `web/core.js`

```js
// The smallest number in `list`, or null for none (Math.min(...list) overflows the stack
// for very long lists, such as a busy user's whole archive timeline).
function minOf(list) {
  let min = null;
  for (const n of list) if (min === null || n < min) min = n;
  return min;
}
```

- [ ] **Step 4: Replace `beforeFacts`** with this (the body of the API path is today's `kind`, unchanged apart from its `after`):

```js
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
// aggregate and the timeline is unknown.
async function beforeFacts(client, username, post, { after, needPosts, needComments, dumps = null }) {
  const fromApi = async (k, since) => {
    const opts = { subreddit: post.subreddit, after: since, before: post.createdUtc };
    let times;
    try {
      times = await client.timestamps(k, username, opts);
    } catch (err) {
      // An overloaded or rate-limiting server, or no connection, won't answer the heavier
      // aggregate either: fail this user rather than pile on more queries.
      if (err instanceof Aborted || err instanceof ServerBusy || err.status === 429 || err.status === null) throw err;
      return { count: sum(await client.subredditCounts(k, username, opts)), times: null, first: null, complete: false };
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
    };
  };
  const [posts, comments] = await settleAll([
    needPosts ? kind("posts") : null,
    needComments ? kind("comments") : null,
  ]);
  const parts = [posts, comments].filter(Boolean);
  const known = parts.every((p) => p.times !== null);
  const days = new Set(parts.flatMap((p) => p.times ?? []).map((t) => Math.floor(t / 86400)));
  const firsts = parts.map((p) => p.first).filter((t) => t !== null);
  return {
    posts: posts?.count ?? 0,
    comments: comments?.count ?? 0,
    first: known ? minOf(firsts) : null,
    days: known ? days.size : null,
    complete: known && parts.every((p) => p.complete),
  };
}
```

- [ ] **Step 5: Pass `dumps` through `buildProfile`**

In `buildProfile`'s signature, add `dumps = null` to the options: `{ only = null, after = null, lastCommentUtc = null, cache = null, dumps = null } = {}`. In its doc comment, add: "With `dumps` (a DumpSource, see dumps.js), "before" facts for a covered subreddit come from its archive files." At the call site, change it to:

```js
      before = await beforeFacts(client, username, post, { after, needPosts, needComments, dumps });
```

- [ ] **Step 6: Run the tests**

Run: `cd web && npm test`
Expected: all pass: the new archive tests and every existing test, since `dumps` defaults to `null`.

- [ ] **Step 7: Commit**

```bash
git add web/core.js web/tests/core.test.js
git commit -m "Take before facts from archive files when a subreddit has them

buildProfile takes an optional DumpSource. For a covered subreddit, each
kind's items come from its archive file up to where the file can be
trusted (an hour before its newest item); the API is asked only about
the gap from there to the post. A failed read falls back to the API for
the whole window; Stop still stops. Long timelines use a loop rather
than Math.min(...list), which overflows the stack.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire it into the page, check it in a browser, and document it

**Files:**
- Modify: `web/app.js` (import; `run()`)
- Modify: `CLAUDE.md`, `README.md`

**Interfaces:**
- Consumes: `DumpSource.open({ signal })`, `dumps.covers(subreddit)` and `dumps.broken` (Task 2); `buildProfile(…, { dumps })` (Task 3).

- [ ] **Step 1: Import it** (next to the other local imports in `web/app.js`)

```js
import { DumpSource } from "./dumps.js";
```

- [ ] **Step 2: Open the archive after the post is found.** In `run()`, directly after `renderWindowNote(after);`:

```js
    // Archive files for the post's subreddit, if there are any: "before" facts come from
    // them rather than Arctic Shift searches. No manifest, or a broken one, means the API.
    const dumps = await DumpSource.open({ signal: controller.signal });
    const archive = dumps?.covers(post.subreddit) ?? null;
```

- [ ] **Step 3: Pass it to `buildProfile`.** In the `mapPool` callback, change the options to:

```js
        profile = await buildProfile(client, username, count, post, {
          only: opts.only, after, lastCommentUtc: last, cache, dumps,
        });
```

- [ ] **Step 4: Say so when the scan ends.** In `run()`, directly before the `if (failed && failed < counts.total && opts.cacheDays > 0)` line:

```js
    if (archive) {
      const upTo = new Date(Math.min(archive.postsThrough, archive.commentsThrough) * 1000)
        .toLocaleDateString(undefined, { dateStyle: "medium" });
      text += dumps.broken
        ? ` The r/${archive.name} archive files stopped answering partway, so Arctic Shift answered for the rest.`
        : ` Activity in r/${archive.name} before the post, up to ${upTo}, came from archive files.`;
    }
```

- [ ] **Step 5: Run the tests**

Run: `cd web && npm test`
Expected: all pass. Also run `node --check app.js` and check that `import { DumpSource } from "./dumps.js"` resolves (the deploy's import check greps exactly this form).

- [ ] **Step 6: Check it in a browser with both services mocked.** Serve `web/` locally (`python3 -m http.server -d web 8000`). With Playwright, `page.route` both hosts:
  - **Arctic Shift** (`https://arctic-shift.photon-reddit.com/**`): answer as in the earlier mocked scan, for post `abc123` in r/Python created 1700000000, with commenters `alice` and `carol`. Answer lifetime aggregates with Python posts and comments > 0, so "before" is needed for both kinds. Answer "before" searches with no items, and record every URL that has a `before` parameter.
  - **The archive** (`https://rpp-db.tinted979.dev/**`): serve `web/tests/fixtures/dumps/` with `Access-Control-Allow-Origin: *`. For requests with a `Range: bytes=a-b` header, reply `206` with that slice and `Content-Range: bytes a-b/<size>`.

  Open `/?post=abc123&cache=0` and wait for "Done". Expected:
  - the status mentions "came from archive files";
  - every recorded "before" search asks only about the gap after the files. The fixture files end before the post, so each carries `after=1699946400` (posts: 1699950000 − 3600) or `after=1699986400` (comments: 1699990000 − 3600). None has no `after`;
  - alice's card reads **"1 post, 3 comments before"**. Her fixture items before 1700000000 are 1 post (1699900000) and 3 comments (1698000000, 1699000000, 1699500000), all before their kind's end time, and the gap searches return nothing;
  - no console errors.

  Then serve a 500 for every archive `.parquet` request and scan again. Expected:
  - the scan still finishes with every user profiled;
  - the status says the archive files "stopped answering";
  - the "before" searches now appear in the Arctic Shift log.

- [ ] **Step 7: Update CLAUDE.md**
  - **Architecture list**, add after `queue.js`:
    - **`dumps.js`:** `DumpSource`: loads the archive manifest from `https://rpp-db.tinted979.dev` (checked as untrusted input), says which subreddits it covers, and reads one author's timestamps from a Parquet file with hyparquet range requests. A failed read switches it off for the rest of the scan; Stop throws `Aborted`. `core.js` doesn't import it: `buildProfile(…, { dumps })` only calls `covers`/`timestamps`.
    - **`hyparquet.js`:** a saved copy of hyparquet 1.31.1's bundled build (MIT). Don't edit it; update it by downloading a new `+esm` build as its header describes.
  - **`buildProfile`, the "before" facts bullet:** add "For a subreddit the archive covers, they come from its files up to an hour before their newest item, and the API is asked only about the gap from there to the post; if the files fail, the API answers for the whole window."
  - **"Subreddit dumps (in progress)":** replace "The page doesn't use them yet." with "The page uses them for "before" facts (`dumps.js`); the thread's commenters still come from the API."
  - **Rules → Tests:** "logic in `core.js`, `cache.js`, `queue.js` and `dumps.js` gets a test in `web/tests/`".

- [ ] **Step 8: Update README.md.** In the numbered "how it works" list, at the end of the step about the "before" facts, add: "For a subreddit with archive files on the project's R2 bucket, currently r/Hasan_Piker, those come from the files instead, with Arctic Shift asked only about the days since the files were built."

- [ ] **Step 9: Commit, push and open the PR**

```bash
git add web/app.js CLAUDE.md README.md docs/superpowers/plans/2026-09-24-archive-before-facts.md
git commit -m "Use archive files for before facts in covered subreddits

run() opens the archive manifest once per scan and passes it to
buildProfile. The finished status says when archive files were used, or
that they stopped answering and Arctic Shift took over.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -u origin claude/archive-before-facts
gh pr create --base main --title "Use archive files for before facts in covered subreddits" --body "…summary, tests, browser check…"
```

Once merged, check that `https://tinted979.github.io/reddit-post-profiler/dumps.js` and `hyparquet.js` are served. Then run one real r/Hasan_Piker scan to compare the request count and time with an earlier scan of the same thread.

---

## Self-review

- **Design coverage:**
  - The ends of the files, the one-hour margin and the exclusive `after`: Task 3, "newer than the files…".
  - Complete timelines: "the whole timeline…".
  - The history window: "the history window…".
  - Failure fallback and switching off: Task 2, "a failed read…", and Task 3, "if the archive fails…".
  - Stop: Task 2 and Task 3.
  - Checking the manifest: Task 2, "parseManifest leaves out…".
  - No change to the stored shape: Task 3 keeps `{posts, comments, first, days, complete}`.
  - Deploying the new files: the Global constraints note on `web/*.js` and Task 4, Step 5.
- **Placeholders:** none. Every code step has its code, and Task 4, Step 6 gives the mock behaviour and expected results in words, since it's a manual browser check with Playwright.
- **Names used across tasks:**
  - `DumpSource.open`, `covers`, `timestamps`, `broken`: Task 2, used in Tasks 3 and 4.
  - `postsThrough`/`commentsThrough`: Task 2, used in Tasks 3 and 4.
  - `INGEST_LAG` exported: Task 2, Step 3.
  - `buildProfile(…, { dumps })`: Task 3, used in Task 4.
- **Review focus:** each of the five items has a named test in its owning task.
