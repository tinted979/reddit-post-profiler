# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Reddit Post Profiler (RPP). Profiles everyone who commented on a Reddit post using the [Arctic Shift](https://github.com/ArthurHeitmann/arctic_shift/blob/master/api/README.md) archive API. It reports:

- each commenter's posts and comments in the post's subreddit *before* the post was created;
- their per-subreddit activity everywhere.

It's a web app in `web/`: plain ES modules with no build step and no dependencies, deployed to GitHub Pages. Results download as a CSV (`toCsv`, one row per user and subreddit). There's no server and no other implementation.

## Commands

```sh
cd web && npm test                        # web tests: node --test (Node 22+)
cd web && node --test --test-name-pattern="Eta" tests/core.test.js   # single web test
python3 -m http.server -d web             # serve the web app locally (ES modules need http)
uv run tools/build_dumps.py --subreddit X --posts X_posts.jsonl --comments X_comments.jsonl   # build dump files into dumps/
tools/upload_dumps.sh                     # upload dumps/ to R2 (rclone remote "r2") and check the public URL
uv run --with duckdb --with pytest pytest tools   # build script tests (CI runs them too)
```

There is no linter or formatter configured.

## Deployment

`.github/workflows/pages.yml` runs the web tests on every push and PR. On the default branch it copies `web/*.html web/*.js web/*.css` into the site and publishes it to Pages. It fails if a module imports a file that wasn't copied, so a new file of another type (such as images or JSON) must be added to that copy step. It also tags local imports, `app.js` and `style.css` with `?v=<commit>`, so browsers never mix cached old and new modules. Keep imports in the form `from "./x.js"` for that rewrite.

`.github/workflows/code-review.yml` has Claude review each pull request once (on open, reopen or ready for review; drafts wait) against this file, posting inline comments. The review instructions are the `prompt` in that workflow. It authenticates with the `CLAUDE_CODE_OAUTH_TOKEN` repo secret (from `claude setup-token`, so reviews use the Claude subscription rather than API billing) and the Claude GitHub App.

The default branch is `main`, and only `main` deploys. Work on a feature branch and open a pull request into `main`; CI runs the tests on the PR, and merging it deploys. After a merge, check that the live `https://tinted979.github.io/reddit-post-profiler/*.js` serves the new code.

## Web app architecture

- **`core.js`** contains all API and profiling logic. It has no DOM access and is tested in Node.
  - **`ArcticShiftClient`:**
    - Spaces request starts by `delay` using a slot scheduler.
    - Caps requests in flight with AIMD: the cap halves on a 429, a "slow down" reply or a network error, and grows back after successes.
    - Every request carries `meta-app=reddit-post-profiler` (`APP_TAG`), so Arctic Shift's maintainer can identify the traffic.
    - A 429 or a network error pauses every request on the client (`_pause`, reported via `onPause`). Per-request backoffs are reported via `onWait`.
    - After repeated "slow down" replies it throws `ServerBusy` instead of escalating to heavier queries.
    - Stop works through an `AbortSignal` that also wakes any sleep in progress.
    - `fetchFn`, `sleep` and `now` can be injected. The tests use a fake clock this way (`makeClient` in `tests/core.test.js`).
  - **Commenters:** `collectCommenters` fetches the whole thread in one `/api/comments/tree` request. It falls back to paging `/api/comments/search` if the tree has `more` stubs, fails, or the thread has at least `TREE_LIMIT` comments.
  - **`buildProfile`:**
    - Lifetime counts come from two parallel `/api/{posts,comments}/search/aggregate` calls.
    - If those time out, it falls back to `/api/users/interactions/subreddits`. That endpoint encodes posts×1e6 + comments in one count via `weight_posts`. After that it falls back to yearly or per-subreddit splits of only the kind that timed out.
    - With `only` limited to subreddits the archive covers, lifetime counts come from the archive up to one cutoff plus a single `interactions` query after it (`after` is exclusive; checked live), cached under their own `lifeonly` keys rather than the full lifetime key, since they only cover the wanted subreddits. If that `interactions` query can't answer, the aggregate fallback above answers instead, without retrying it.
    - "Before" facts (`beforeFacts`) come from timestamp searches (`client.timestamps`: `/api/{kind}/search?fields=created_utc&limit=100`), giving the count, distinct days active and first date in one request per kind; past 100 items the aggregate gives the exact count and an `asc` search the first date, and days become a lower bound (`targetTimelineComplete: false`). If the search fails, the aggregate count is used with no timeline. They're skipped when the lifetime totals already prove the answer. For a subreddit the archive covers, they come from its files up to an hour before their newest item, and the API is asked only about the gap from there to the post; if the files fail, the API answers for the whole window.
    - It reads and writes the optional cache. Lifetime totals are trusted only if fetched at least `INGEST_LAG` after the post and after the user's last comment in the thread.
  - **Badges** (`DEFAULT_BADGES`, `profileFacts`, `activityTier`, `parseBadges`/`formatBadges`, `badgeFacts`/`tierCounts`): new here / occasional / regular from posts+comments, days active and tenure, each with a configurable threshold (0 = off; unknown facts skip their check). Tiers are never stored: `app.js` works them out when rendering from the stored facts, so changing the rules re-rates results and saved scans (their summaries keep `facts`) with no requests.
  - **`estimateScan`** gives a rough request count and time before a scan (from saved lifetime totals). Above `LARGE_SCAN` (300) users, `app.js` asks before profiling them all, unless `max` is set; queued scans take the top 300.
  - **Saved scans as a file** (`exportScans`, `parseScanExport`, `importScan`): imported files are untrusted, so every field is checked, names must match `[\w-]`, and stats and badge facts are recomputed from the profiles.
  - **`Eta`** estimates time left from the recent pace of users that needed requests, leaving out saved results and shared pauses.
- **`cache.js`:** IndexedDB DB `reddit-tool` (version 2; like the `reddit-tool-*` localStorage keys, it keeps the project's old name so visitors' saved data survives the rename, so don't rename them) with two stores sharing one connection; `MemoryBackend` for tests. Adding a store means bumping `DB_VERSION` and adding it to `STORES`.
  - `counts`: `ProfileCache`, the per-user results `buildProfile` reuses. It has a TTL and prunes old records. Keys are versioned (`v1|life|…`, `v1|lifeonly|…` (rows for one `only` set, from the archive), `v2|before|…`, the latter `{posts, comments, first, days, complete}`); bump the version if the stored value shape changes.
  - `scans`: `ScanStore`, snapshots of finished or stopped scans (`sum|<id>` summary for the list, `data|<id>` serialized profiles) that `app.js` reopens with no requests. Kept until deleted. A scan's two records are written in one transaction (`setMany`). `exportAll`/`importAll` back the export and import buttons; an import replaces a saved scan only if it's newer.
  - A store that hangs turns itself off instead of blocking the page.
- **`queue.js`:** `LinkQueue`, the scheduler's queue (localStorage, key `reddit-tool-queue`; storage injectable for tests). At most `MAX_WAITING` (25) items wait or run at once; queued scans run at most `QUEUE_CONCURRENCY` (2, in `app.js`) users in parallel. Items keep the options from when they were added; a `running` item found on load was cut off and goes back to `waiting`. Only one tab runs the queue: `app.js` holds a Web Lock (`claimQueue`), and other tabs `load({ readOnly: true })`, follow `storage` events and take over when the lock frees. `retry` refuses duplicates and a full queue.
- **`dumps.js`:** `DumpSource`: loads the archive manifest from `https://rpp-db.tinted979.dev` (checked as untrusted input), says which subreddits it covers, and reads one author's timestamps from a Parquet file with hyparquet range requests. A failed read switches it off for the rest of the scan; Stop throws `Aborted`. `core.js` doesn't import it: `buildProfile(…, { dumps })` only calls `covers`/`timestamps`.
- **`hyparquet.js`:** a saved copy of hyparquet 1.31.1's bundled build (MIT). Don't edit it; update it by downloading a new `+esm` build as its header describes.
- **`app.js`** handles the DOM only:
  - It reads and clamps the options. Share links use URL params `post`, `max`, `op`, `exclude`, `subs`, `years`, `min`, `delay`, `par`, `cache` and `badges`. Badge rules live outside `#option-fields` (editable during a run) and are remembered in localStorage (`reddit-tool-badges`); a link's `badges=` applies without being saved.
  - It runs `mapPool(buildProfile)` and inserts cards in thread-activity order as results arrive.
  - It renders the status line, progress and ETA, and builds the CSV with `toCsv`.
  - Every run has a `runId`. Callbacks from an older run must check it before touching shared state.
  - `run()` resolves with an outcome (`done`, `empty`, `stopped`, `failed`, …). The scheduler (`pumpQueue`) fills the form from a queued item, calls `run({ fromQueue: true })`, and continues after each scan (with a short gap); every run's end calls `pumpQueue`, so a queue waiting on a manual scan resumes. Queued scans don't write the URL, since a reload would re-run them outside the queue.
  - The client's waits use `backgroundSleep`, which runs on a Web Worker timer (Chrome throttles hidden-tab timers to about once a minute after 5 minutes; worker timers aren't) and falls back to `setTimeout` until the worker has answered a ping.

Accessibility is maintained. The last check with axe-core reported 0 violations in both light and dark mode. Screen readers get milestones through `#announce`, not every progress tick. Colour pairs in `style.css` are chosen for at least 4.5:1 contrast.

## Rules for changes

The automatic pull request review (`.github/workflows/code-review.yml`) checks changes against this file, so these are the rules to hold to:

- **Stale runs:** anything async in `app.js` that touches shared state or the page after an `await` must check its `runId` (or `state.controller`) first.
- **Stored data:** bump the cache key version (`v1|life|…`, `v2|before|…`) when a stored value's shape changes, and never rename the `reddit-tool` IndexedDB database or the `reddit-tool-*` localStorage keys: visitors would lose their saved scans, results, queue and badge settings.
- **Untrusted input:** API responses and imported saved-scan files are untrusted. Put text in with `textContent`/`el()`, never `innerHTML`; build links from a fixed `https://` prefix or `URLSearchParams`; validate imported fields as `importScan` does.
- **Imports:** keep local imports as `from "./x.js"` (the deploy step's cache busting rewrites exactly that form), and add any new file type to the deploy copy step.
- **The API:** Arctic Shift is a free shared service. New requests go through `ArcticShiftClient._get` (pacing, backoff, `meta-app`); don't add request patterns that bypass its throttle, and don't fall back to heavier queries when the server is busy or rate-limiting.
- **Accessibility:** keep keyboard focus somewhere sensible when elements hide, announce milestones through `#announce` rather than every tick, and keep colour pairs at 4.5:1 or better.
- **Tests:** logic in `core.js`, `cache.js`, `queue.js` and `dumps.js` gets a test in `web/tests/`; `npm test` must pass.
- **Git workflow:** for any code change, create a `claude/<topic>` branch before editing. When the work is done and `npm test` passes, commit, push, and open a PR into `main` with `gh pr create`. Never push to `main` directly or merge PRs yourself.

## Subreddit dumps (in progress)

Planned: serve Arctic Shift's per-subreddit dumps as static Parquet (on Cloudflare R2) so scans of a covered subreddit take the thread's commenters and the "before" facts from files instead of the API. Lifetime counts still need the API, since a subreddit's dump doesn't cover the rest of Reddit. The page uses them for "before" facts (`dumps.js`); the thread's commenters still come from the API.

- `tools/build_dumps.py` (Python, DuckDB via `uv`) turns a subreddit's posts and comments JSONL into `posts_by_author`, `comments_by_author` (lowercase author, `created_utc`; sorted by author) and `comments_by_link` (`link_id` without `t3_`, author as written, `created_utc`), plus `manifest.json` (format version, and per subreddit the build directory and `posts_to_utc`/`comments_to_utc`, the times the data runs to). It keeps no text, drops deleted accounts and AutoModerator, and de-duplicates by id. Builds go in `r/<sub>/<version>/` and are never overwritten; only the manifest changes.
- Hosting: R2 bucket `rpp-db`, served at `https://rpp-db.tinted979.dev` (custom domain, proxied, with a Cache Rule making it eligible for cache). Its CORS policy is `tools/r2-cors.json`: GET/HEAD from the Pages origin and `localhost:8000`, `Range` allowed, `Content-Range`/`Content-Length`/`Accept-Ranges`/`ETag` exposed. If the page moves origin, add the new one there and in the bucket settings. `tools/upload_dumps.sh` uploads build files first (`immutable`, a year, never replaced), then the manifest (5 minutes), then checks every file answers a range request with 206, the full size in `Content-Range`, CORS and no `Content-Encoding`. It never deletes: old builds stay until removed by hand. The rclone token is limited to Object Read & Write on the bucket and stays out of the repo.
- Files are Snappy-compressed (hyparquet reads Snappy with no extra package) in ~10k-row groups. Measured on r/Hasan_Piker (131k posts, 792k comments): 1.3 MB, 5.8 MB and 10.6 MB; one user's comments read 71 KB and a 1,922-comment thread 285 KB, plus a 64 KB footer read.
- For the browser, [hyparquet](https://github.com/hyparam/hyparquet) skips row groups by min/max statistics only for operator filters: `filter: { author: { $eq: name } }`. A plain `{ author: name }` gives the right rows but reads the whole file. Pass `initialFetchSize: 64 * 1024` to `parquetMetadataAsync`; the default reads the last 512 KB.

## Tech debt

Known debt is tracked in the RPP Debt Ledger, a claude.ai artifact: https://claude.ai/artifact/NjkGa4wzYbRHb4oxZb3jcd. Its items are in the artifact's database, collection `items` (fields include `status`: `open` | `active` | `done` | `dropped`, `phase`, `pr`, `note`), readable and writable with the `ArtifactData` tool. Before refactoring or cleanup, check whether a ledger item covers it; when a PR addresses one, set its `status` and `pr` there. Add newly found debt as a new item rather than republishing the page.

## Arctic Shift API facts (verified live)

- The rate-limit header `x-ratelimit-reset` isn't exposed to browsers because there's no CORS expose header, so the web app waits 30 s on a 429.
- A 422 "Timeout. Maybe slow down a bit" is the server-busy reply and is retried. It is not a client error.
- Throughput tops out at about 0.8 requests/s (about 10 users/min for a fresh scan) whatever the settings: with 2 or more users in parallel a request takes about 1.3 s, and 3–5 in parallel only bring more "slow down" replies (benchmarked Sept 2026 over a delay 0.25–1 s × parallel 1–5 grid). That's why the defaults are 0.75 s and 2 in parallel. The rate limit resets on 60 s boundaries (`x-ratelimit-reset-at` steps by 60000 ms, and `x-ratelimit-reset` stays at or under 60) and appears to be per IP: a sandbox sharing its IP got 429s while idle.
- `/api/comments/tree` accepts `limit` up to 25000 and does not support `fields`.
- `aggregate=created_utc&frequency=…` answers all-zero counts (even with only a subreddit filter), so it can't give a timeline; search with `fields=created_utc` can.
- `interactions` has no `subreddit` parameter. It returns 400 "not supported" for huge accounts such as AutoModerator.
- `/api/users/interactions/subreddits`'s `after` is exclusive, like search's (an item at exactly `after` isn't counted).
- The search website (`/search?fun=posts_search|comments_search&author=&subreddit=&after=`) is a front end over the same API, so scraping it saves nothing.

## Sandbox testing notes

Headless Chromium doesn't trust the container's proxy CA. For live browser tests, relay the Arctic Shift requests through Node `fetch` with `page.route` (run Node with `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`) rather than disabling TLS. For UI checks that don't need live data, mock the API with `page.route`.
