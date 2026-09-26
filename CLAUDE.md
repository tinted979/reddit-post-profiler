# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Reddit Post Profiler (RPP). Profiles everyone who commented on a Reddit post using the [Arctic Shift](https://github.com/ArthurHeitmann/arctic_shift/blob/master/api/README.md) archive API. It reports:

- each commenter's posts and comments in the post's subreddit *before* the post was created;
- their per-subreddit activity everywhere, also up to the post: every count stops at the post (docs/adr/0006).

It's a web app in `web/`: plain ES modules with no build step and no runtime dependencies, deployed to GitHub Pages. (The tests have one dev dependency, fake-indexeddb.) Results download as a CSV (`toCsv`, one row per user and subreddit). There's no server and no other implementation.

## Commands

```sh
cd web && npm ci && npm test              # web tests: node --test (Node 22+, pinned in web/.nvmrc); npm ci once, for fake-indexeddb
cd web && node --test --test-name-pattern="Eta" tests/core.test.js   # single web test
python3 -m http.server -d web             # serve the web app locally (ES modules need http)
uv run tools/build_dumps.py --subreddit X --posts X_posts.jsonl --comments X_comments.jsonl   # build dump files into dumps/
uv run tools/build_dumps.py --subreddit X --posts new_p.jsonl --comments new_c.jsonl --splice live --cut <epoch> --posts-through <epoch> --comments-through <epoch> --out live   # splice fetched rows onto a downloaded live build
tools/upload_dumps.sh [dumps] [--drop KEY]   # check against what's live, upload dumps/ to R2 (rclone remote "r2"), check the public URL
tools/upload_dumps.sh [dumps] --only KEY [--allow-older]   # just r/KEY's build, into the live manifest (merge-one, then publish_build.sh): other subreddits stay as they're live
uv run tools/check_upload.py merge-one --key x --dumps dumps --live live.json --log published.json --out bundle   # one subreddit's build, merged into the live manifest and checked, ready to publish (no token)
tools/publish_build.sh bundle   # publish that bundle to R2: the one step that holds the token (rclone, curl and sha256sum only)
uv run tools/archive_sync.py plan   # which subreddits in tools/archive.json are due for the archive sync (reads the public archive only)
uv run tools/archive_sync.py build --out DIR [--only X]   # the sync's build job: fetch, splice, and bundles in DIR/bundles for publish_build.sh (fetches call the live API: not from tests or agents)
tools/check_dumps.sh [all|manifest|cors|files]  # check the live archive serves the page right (no credentials; CI runs it weekly)
node tools/fetch_subreddit.mjs --subreddit X --kind comments --after <epoch> --budget 50 --out c.jsonl --result c.json   # the sync's fetcher (calls the live API: never from tests or agents)
node tools/lifetime_bench.mjs --post <url> [--out bench.json]   # P8: one interactions query vs the two aggregates, per commenter (calls the live API: the owner runs it)
uv run --with duckdb --with pytest pytest tools   # dump tool tests (CI runs them too)
bash .github/scripts/rule-guards.sh              # the Rules for changes a grep can decide (CI runs it)
node --test .github/scripts/tests/*.test.mjs      # tests of the CI scripts
node web/bench/scan-bench.mjs [--base <git-ref>]   # offline scan benchmark: requests by endpoint, archive reads/bytes, simulated seconds; no network
```

There is no linter or formatter for the code; CI lints only shell scripts (shellcheck) and workflows (actionlint, zizmor).

## How changes reach `main`

- Everything lands through a pull request into `main`, and merging deploys to GitHub Pages. Only the owner merges: rulesets require green `checks / test` and `checks / guards` (no bypass), and a code-owner approval that no bot or token can give (the owner bypasses it only for their own PRs). Agents can't push to the owner's branches.
- CI (`ci.yml` calling `checks.yml`) runs the tests, the grep-able rules (`.github/scripts/rule-guards.sh`) and, on PRs, the guards (`pr-guards.sh`, from the base branch): agent work may never touch `.github/`, `.claude/`, CLAUDE.md, `web/hyparquet.js` or `tools/r2-cors.json`, and the owner's own changes there need the `ack:sensitive` label. Tests removed or skipped, and agent changes to existing tests or to what decides which tests run, need `ack:tests`; more than 600 changed lines need `ack:large`.
- Agents: read-only reviewers comment on PRs (`agent-review.yml`); writers turn an issue the owner labels `agent:implement` or `agent:refactor` into a draft PR (`agent-write.yml`, with the owner's writer app); audits file at most three findings as issues (`agent-audit.yml`). Roles are `.claude/agents/*.md`; the repository variable `AGENTS_ENABLED` switches them all off.
- The details (workflows, rulesets, the path hook, the writer app, what each guard checks) load from `.claude/rules/ci-and-agents.md` when you open a file under `.github/` or `.claude/`. The design and its reasons are in `WORKFLOW.md`.

## Web app map

Detail for each module loads from `.claude/rules/` when you open its files. Every module but `app.js` has no DOM access.

- **`core.js`:** `ArcticShiftClient` (pacing, AIMD backoff, `meta-app`), commenters, a covered subreddit's tail (`fetchTails`, once per scan), `buildProfile` (lifetime counts and "before" facts, from the API or the archive), badges, scan estimates, CSV and saved-scan files, `Eta`. No DOM. (`web-core.md`, and the verified API behaviour in `arctic-shift-api.md`.)
- **`cache.js`:** IndexedDB `reddit-tool` with the `counts` (`ProfileCache`) and `scans` (`ScanStore`) stores; **`queue.js`:** `LinkQueue` in localStorage, run by one tab at a time. (`web-storage.md`.)
- **`dumps.js`:** `DumpSource`, the per-subreddit Parquet archive on R2, read with hyparquet range requests, and `TailStore`, the tab's tails of activity after the files end; **`hyparquet.js`:** a saved copy, never edited; **`tools/`:** fetches for, builds, uploads and checks the archive, which `archive-sync.yml` keeps current hourly (`docs/archive-runbook.md`). (`archive.md`.)
- **`options.js`** (scan options and share links), **`format.js`** (text helpers), **`app.js`** (the DOM only: runs, cards, the scheduler, saved scans). (`web-app.md`.)

## Rules for changes

The AI pull request reviewers (`.github/workflows/agent-review.yml`, roles in `.claude/agents/`) check changes against this file, so these are the rules to hold to:

- **Stale runs:** anything async in `app.js` that touches shared state or the page after an `await` must check its `runId` (or `state.controller`) first.
- **Stored data:** bump the cache key version (`v1|life|…`, `v2|before|…`) when a stored value's shape changes, and never rename the `reddit-tool` IndexedDB database or the `reddit-tool-*` localStorage keys: visitors would lose their saved scans, results, queue and badge settings (docs/adr/0003).
- **Untrusted input:** API responses, the archive manifest and imported saved-scan files are untrusted. Put text in with `textContent`/`el()`, never `innerHTML`; build links from a fixed `https://` prefix with each name `encodeURIComponent`-ed (`redditPostUrl`, `redditSubredditUrl`) or `URLSearchParams`; validate imported fields as `importScan` does (it also renumbers ranks, which index the page's card slots).
- **Content-Security-Policy:** `index.html` has a meta CSP: only the site's own scripts and styles, `connect-src` limited to Arctic Shift and the archive host, a `blob:` worker. A new host the page fetches from goes in `connect-src` (a test in `dumps.test.js` checks it against `BASE_URL`/`DUMPS_URL`); don't add `'unsafe-inline'` or `'unsafe-eval'`.
- **Imports:** keep local imports as `from "./x.js"` (the deploy step's cache busting rewrites exactly that form), and add any new file type to the deploy copy step (docs/adr/0001).
- **The API:** Arctic Shift is a free shared service. New requests go through `ArcticShiftClient._get` (pacing, backoff, `meta-app`); don't add request patterns that bypass its throttle, and don't fall back to heavier queries when the server is busy or rate-limiting (docs/adr/0002).
- **Accessibility:** keep keyboard focus somewhere sensible when elements hide, announce milestones through `#announce` rather than every tick, and keep colour pairs at 4.5:1 or better.
- **Tests:** logic in `core.js`, `cache.js`, `queue.js`, `dumps.js`, `options.js` and `format.js` gets a test in `web/tests/` (storage behaviour in `tests/cache.test.js`, which runs against both `MemoryBackend` and the real `IndexedDbBackend` on fake-indexeddb), so logic that needs no DOM goes in one of those rather than `app.js`; `npm test` must pass. Numbers in `index.html`'s help text that come from a constant are marked `<span data-const="NAME">`, and `tests/page.test.js` checks them (and the history-window options) against the code.
- **Dump tools:** builds are never overwritten (a new build gets a new `r/<sub>/<version>/`), and deleted only by `publish_build.sh`'s prune step. It deletes a build only when its subreddit's publish log says it was replaced at least 72 h ago, and neither the old nor the new manifest names it; builds the log doesn't know are reported, never deleted (docs/adr/0005); bump `FORMAT` in `build_dumps.py` and `DUMP_FORMAT` in `dumps.js` together, page first, when the files' columns, sort order or the manifest's shape change; keep each file sorted by its lookup key (hyparquet skips row groups by min/max); and keep `upload_dumps.sh`'s order (preflight, build files, checks, then the manifest) and `publish_build.sh`'s (the live manifest unchanged, no existing build, build files, checks, the live manifest still unchanged, the manifest, the publish log, then any prunes). `publish_build.sh` holds the R2 token in the sync, so it stays shell with rclone, curl, sha256sum and coreutils only, and checks every name in its bundle before any rclone call. Tool logic gets a pytest test in `tools/tests/` (the Node fetcher's are in `web/tests/fetch-subreddit.test.js`, so `npm test` runs them). `tools/tests/test_contract.py` rebuilds the page's committed fixtures (`web/tests/fixtures/dumps`, from `dumps-src/`) and checks them and `web/dumps.js` (format, file names, columns) against the script; when it fails, rebuild the fixtures as its message says and update `dumps.js` to match (docs/adr/0005).
- **Git workflow:** for any code change, create a `claude/<topic>` branch before editing, with a topic that doesn't start with a digit (CI writers use `claude/<issue>-<slug>`, and the rulesets tell the two apart by that). When the work is done and `npm test` passes, commit, push, and open a PR into `main` with `gh pr create`, its body following `.github/pull_request_template.md`. Never push to `main` directly or merge PRs yourself. Never edit an existing test to make it pass; say in the PR if a test looks wrong.

## Backlog and decisions

- Known debt is GitHub issues labelled `debt`; agent findings are labelled `agent:finding`. Before refactoring or cleanup, check whether an issue covers it, and close it from the PR (`Closes #N`). File newly found debt as a `debt` issue.
- Lasting decisions are in `docs/adr/` (no build step or dependencies, Arctic Shift etiquette, frozen storage names, the static archive and its scheduled sync, every count stopping at the post); the `adr` skill says how to add one.
- Live browser checks: the `live-browser-test` skill.
