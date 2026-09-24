# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Profiles everyone who commented on a Reddit post using the [Arctic Shift](https://github.com/ArthurHeitmann/arctic_shift/blob/master/api/README.md) archive API. It reports:

- each commenter's posts and comments in the post's subreddit *before* the post was created;
- their per-subreddit activity everywhere.

There are two independent implementations that write the same CSV format:

- **Web app:** `web/`, plain ES modules with no build step and no dependencies. Deployed to GitHub Pages.
- **Python CLI:** `src/reddit_tool/`, using httpx and managed with uv.

They share no code. The CLI is deliberately simpler: it profiles one user at a time with 4 aggregate requests each, has no cache, and always pages the comment search. Web-only features such as `subs`, `years`, the result cache, the interactions endpoint and the comment tree don't exist in the CLI.

## Commands

```sh
uv run pytest -q                          # Python tests (respx mocks httpx)
uv run pytest tests/test_api.py -k name   # single Python test
cd web && npm test                        # web tests: node --test (Node 22+)
cd web && node --test --test-name-pattern="Eta" tests/core.test.js   # single web test
python3 -m http.server -d web             # serve the web app locally (ES modules need http)
```

There is no linter or formatter configured.

## Deployment

`.github/workflows/pages.yml` runs both test suites on every push and PR. On the default branch it copies `web/*.html web/*.js web/*.css` into the site and publishes it to Pages. It fails if a module imports a file that wasn't copied, so a new file of another type (such as images or JSON) must be added to that copy step. It also tags local imports, `app.js` and `style.css` with `?v=<commit>`, so browsers never mix cached old and new modules. Keep imports in the form `from "./x.js"` for that rewrite.

The working branch is also the repo's default branch, so **every push deploys**. After pushing, check that the live `https://tinted979.github.io/reddit-tool/*.js` serves the new code.

## Web app architecture

- **`core.js`** contains all API and profiling logic. It has no DOM access and is tested in Node.
  - **`ArcticShiftClient`:**
    - Spaces request starts by `delay` using a slot scheduler.
    - Caps requests in flight with AIMD: the cap halves on a 429, a "slow down" reply or a network error, and grows back after successes.
    - A 429 or a network error pauses every request on the client (`_pause`, reported via `onPause`). Per-request backoffs are reported via `onWait`.
    - After repeated "slow down" replies it throws `ServerBusy` instead of escalating to heavier queries.
    - Stop works through an `AbortSignal` that also wakes any sleep in progress.
    - `fetchFn`, `sleep` and `now` can be injected. The tests use a fake clock this way (`makeClient` in `tests/core.test.js`).
  - **Commenters:** `collectCommenters` fetches the whole thread in one `/api/comments/tree` request. It falls back to paging `/api/comments/search` if the tree has `more` stubs, fails, or the thread has at least `TREE_LIMIT` comments.
  - **`buildProfile`:**
    - Lifetime counts come from two parallel `/api/{posts,comments}/search/aggregate` calls.
    - If those time out, it falls back to `/api/users/interactions/subreddits`. That endpoint encodes posts×1e6 + comments in one count via `weight_posts`. After that it falls back to yearly or per-subreddit splits of only the kind that timed out.
    - "Before" counts use the same aggregates with `subreddit` and `before`. They're skipped when the lifetime totals already prove the answer.
    - It reads and writes the optional cache. Lifetime totals are trusted only if fetched at least `INGEST_LAG` after the post and after the user's last comment in the thread.
  - **`Eta`** estimates time left from the recent pace of users that needed requests, leaving out saved results and shared pauses.
- **`cache.js`:** IndexedDB DB `reddit-tool` (version 2) with two stores sharing one connection; `MemoryBackend` for tests. Adding a store means bumping `DB_VERSION` and adding it to `STORES`.
  - `counts`: `ProfileCache`, the per-user results `buildProfile` reuses. It has a TTL and prunes old records. Keys are versioned (`v1|life|…`, `v1|before|…`); bump the version if the stored value shape changes.
  - `scans`: `ScanStore`, snapshots of finished or stopped scans (`sum|<id>` summary for the list, `data|<id>` serialized profiles) that `app.js` reopens with no requests. Kept until deleted.
  - A store that hangs turns itself off instead of blocking the page.
- **`queue.js`:** `LinkQueue`, the scheduler's queue (localStorage, key `reddit-tool-queue`; storage injectable for tests). Items keep the options from when they were added; a `running` item found on load was cut off and goes back to `waiting`.
- **`app.js`** handles the DOM only:
  - It reads and clamps the options. Share links use URL params `post`, `max`, `op`, `exclude`, `subs`, `years`, `min`, `delay`, `par` and `cache`.
  - It runs `mapPool(buildProfile)` and inserts cards in thread-activity order as results arrive.
  - It renders the status line, progress and ETA, and builds the CSV with `toCsv`.
  - Every run has a `runId`. Callbacks from an older run must check it before touching shared state.
  - `run()` resolves with an outcome (`done`, `empty`, `stopped`, `failed`, …). The scheduler (`pumpQueue`) fills the form from a queued item, calls `run({ fromQueue: true })`, and continues after each scan (with a short gap); every run's end calls `pumpQueue`, so a queue waiting on a manual scan resumes. Queued scans don't write the URL, since a reload would re-run them outside the queue.
  - The client's waits use `backgroundSleep`, which runs on a Web Worker timer (Chrome throttles hidden-tab timers to about once a minute after 5 minutes; worker timers aren't) and falls back to `setTimeout` until the worker has answered a ping.

Accessibility is maintained. The last check with axe-core reported 0 violations in both light and dark mode. Screen readers get milestones through `#announce`, not every progress tick. Colour pairs in `style.css` are chosen for at least 4.5:1 contrast.

## Arctic Shift API facts (verified live)

- The rate-limit header `x-ratelimit-reset` isn't exposed to browsers because there's no CORS expose header, so the web app waits 30 s on a 429.
- A 422 "Timeout. Maybe slow down a bit" is the server-busy reply and is retried. It is not a client error.
- `/api/comments/tree` accepts `limit` up to 25000 and does not support `fields`.
- `interactions` has no `subreddit` parameter. It returns 400 "not supported" for huge accounts such as AutoModerator.
- The search website (`/search?fun=posts_search|comments_search&author=&subreddit=&after=`) is a front end over the same API, so scraping it saves nothing.

## Sandbox testing notes

Headless Chromium doesn't trust the container's proxy CA. For live browser tests, relay the Arctic Shift requests through Node `fetch` with `page.route` (run Node with `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`) rather than disabling TLS. For UI checks that don't need live data, mock the API with `page.route`.
