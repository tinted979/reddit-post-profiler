> **Status.** Current plan, being built in phases. The decisions are recorded in docs/adr/0005. P0 (the live checks, the ADR and this file) is the first PR. Update this note as phases land.

# Fewer Arctic Shift requests: shared subreddit tails, and a scheduled archive sync

## Context

The R2 archive (`rpp-db`) was built and uploaded by hand, and covers one subreddit (hasan_piker). Even there the page still sends per-commenter requests: a scanned thread is nearly always newer than the build, and each commenter asks separately about the time since the build. The goal is to host as much as possible so the page asks Arctic Shift as little as possible.

This merges two proposals:
- **From a delta proposal** (written with another model): fetch the post-build gap **once per subreddit per scan** (a "tail") rather than once per commenter, and read thread commenters from `comments_by_link`.
- **From the sync plan:** a scheduled sync that keeps builds fresh, publishes one subreddit at a time, and prunes old builds, run from a locked-down workflow, with "cutoff = complete up to".

**Owner decisions:**
- **Scope:** only chosen subreddits, each with its own cadence (hourly to weekly).
- **Where the sync runs:** a GitHub Actions scheduled workflow.
- **Source:** the Arctic Shift API only. Per-subreddit torrents were taken down in July 2026.
- **Storage:** splice onto the previous public build, with a weekly 7-day repair. There is no private lake and no text.
- **`interactions`-first lifetime counts:** only after a live benchmark.

**Live check, 2026-09-25** (recorded in `.claude/rules/arctic-shift-api.md`):
- Subreddit-wide search works and pages at **100 rows** (`limit=auto` = 100).
- It answers in 0.3–1.4 s, even on r/AskReddit.
- Hasan_Piker gets about 1,900 comments and 80 posts a day. A tail therefore costs about 1 page per kind for a 1 h-old build, ~20 for a 1-day-old one and ~130 for a 7-day-old one.
- Backfilling hasan_piker through the API would take about 16k requests, so import the download tool's JSONL instead.
- r/AskReddit (~200k comments/day) is too busy to cover.

**Expected requests** (estimates; covered subreddit, build under a day old):

| Scan | Today | After P1–P2 | + sync (P7) | + interactions (P8b) |
|---|---|---|---|---|
| "Only" scan, all covered, 66 commenters | ~68 | ~3 + tail pages | ~3–7 total | same |
| Next queued post, same subreddit, same tab | ~68 | ~1 + new tail pages | ~2–3 | same |
| Full scan, covered post subreddit | 2–4 per commenter + 2 | 2 per commenter + tail | same | 1 per commenter + tail |
| Uncovered subreddit | 2–4 per commenter | unchanged | unchanged | 1–3 per commenter |

**Dropped:**
- a per-user gap skip (the tail supersedes it);
- the private lake;
- leaving out `comments_by_link` (it becomes useful: #55).

**Deferred:**
- `posts_by_id` (needs titles; saves 1 request per scan);
- row-group prefetch (speed only);
- choosing coverage from saved scans;
- an IndexedDB tail.

## Design

### Page: one shared tail per covered subreddit (P1)

- **The request.** Once per scan, for each covered subreddit in play (the post's own, plus covered ones in `only`), page:
  `/api/{kind}/search?subreddit=S&after=<files through>&sort=asc&limit=auto&fields=id,author,created_utc[,link_id]`
  - Clean the rows as `build_dumps.py` does: drop `[deleted]`, `[removed]` and AutoModerator, and de-duplicate by id.
- **The tail extends the archive.** `DumpSource.covers(sub)` reports a `through` moved forward to what the tail completed, and `timestamps()` returns file rows plus tail rows. The existing `beforeFacts`/`archiveLifetime` logic then needs no gap search and no per-user `interactions` once every wanted tail reached the present.
- **Budget.** Pages are scaled from the post's `num_comments`: about 1 per 50 comments, min 2 and max 20 per kind. Tune it with the bench.
  - If the budget runs out, `through` moves only as far as the tail got, and per-user requests cover the rest through the existing paths.
  - No manifest change.
- **Failures.**
  - `refusesMore` (busy, 429, network) fails the scan, as `collectCommenters` does (0002).
  - `QueryTimeout` drops the tail, and the per-user path answers.
- **Memory.** The tail is kept in memory per tab, keyed by subreddit and build version. The next queued scan asks only for rows after its high-water mark (a small overlap, de-duplicated by id), and a new build's `through` drops older rows. There are no IndexedDB changes.
- **Shared paging.** Extract `iterThreadComments`' paging (`after = last − 1`, de-dupe by id, stop on 2 stale pages) into `ArcticShiftClient.iterAscending(path, params, pageSize)`. The tail and the sync's fetcher both use it.

### Page: thread from `comments_by_link` (P2)

- **Covered posts.** `collectCommenters` takes the post's rows from `comments_by_link` (`$eq` on `link_id`, up to the files' `through`), plus the tail's comment rows for this `link_id`.
  - If the tail reached the present, there's no tree request. Otherwise it uses the tree request, as today.
- **Same rules as the tree.** Exclusions and `includeOp` apply the same way, and authors keep their spelling.
- **Manifest.** `parseManifest` accepts `comments_by_link` as an optional file, with no format bump.

### Scheduled sync by splicing (P3–P7)

- **The splice.** Given the live build and a cut C, keep each file's rows with `created_utc <= C`, add the API's rows after C (cleaned the same way), and write a new full build.
  - A normal sync uses C = cutoff − 2 h; the weekly repair uses C = cutoff − 7 days.
  - Rows after C are dropped and fetched again, so nothing is duplicated and no ids are needed.
- **The cutoff means "complete up to"**, per kind:
  - the time paging reached an empty page, minus ~60 s;
  - or, if the budget ran out, the last page's newest item − 1.

  The page still subtracts `INGEST_LAG`. The manifest shape doesn't change, so there's no FORMAT/DUMP_FORMAT bump.
- **Backfill** comes from one of two sources:
  - The API: start from an empty base and page ascending, one budget per run. Each run publishes a correct partial build (complete from the start up to its cutoff).
  - An import: build locally from download-tool JSONL, then `upload_dumps.sh --only`.
- **The fetcher,** `tools/fetch_subreddit.mjs`, runs the page's `ArcticShiftClient` in Node:
  - `delay: 1`, one request in flight;
  - `appTag: "reddit-post-profiler-archive"`;
  - a request budget.

  When the server is busy it stops with a partial result, and it never escalates.
- **Publishing one subreddit,** with `upload_dumps.sh --only KEY`:
  1. merge into the **live** manifest;
  2. upload only `r/KEY/<version>/` (versions `YYYY-MM-DDTHHMMSSZ`);
  3. check the files;
  4. re-read the live manifest and abort if it changed;
  5. upload the manifest last;
  6. append to `r/KEY/published.json`.
- **The token** is visible only to `tools/*.sh` scripts, which are already security-reviewed. They keep it in an unexported shell variable and pass it only to rclone, so the Python and Node tools never see it.
- **Pruning.** A build is deleted only when all of these hold:
  - it isn't live;
  - it isn't its subreddit's newest;
  - its replacement was published at least 72 h ago, per the log.

  Builds that aren't logged are reported, never deleted.

## Phases (one PR each; `claude/<topic>` branches)

- **P0: Decision and live checks** (owner, `ack:sensitive`).
  - Done: the live checks, recorded in `arctic-shift-api.md`.
  - Also in this PR:
    - ADR 0005, superseding 0004;
    - CLAUDE.md, `archive.md` and the architecture reviewer point at 0005;
    - this file.
  - No `review-route.sh` change is needed, because of the token rule above. WORKFLOW.md's "the R2 token never touches GitHub" changes in P7b, when that stops being true.
- **P1: Shared tail in the page.**
  - `core.js`: `iterAscending`, which `iterThreadComments` delegates to; `fetchTail`; and `archiveLifetime` skips `interactions` when every tail is complete.
  - `dumps.js`: `addTail`, an extended `covers()`, `timestamps()` merging file and tail rows, and a per-tab `TailCache`.
  - `app.js`: fetch the tails after the post and manifest, with `runId` checked after each await.
  - Tests: new `web/tests/tail.test.js`, plus `dumps.test.js`. Bench scenarios: "build N days old", "25-link queue", "`only` covered".
  - Docs: README, and the help text using `data-const`.
- **P2: Thread from `comments_by_link`** (closes #55). `dumps.js` gets `threadRows(sub, linkId)`; `collectCommenters` takes a covered-post path and falls back to the tree. Tests and bench.
- **P3: Fetcher.** A `core.js` `appTag` option and `tools/fetch_subreddit.mjs`. Tests in a new `web/tests/fetch-subreddit.test.js`.
- **P4: Splice builder.** `build_dumps.py --splice <prev build> --cut <utc>`, `--posts-through/--comments-through` and timestamp versions. The JSONL-only mode is unchanged. Tests in a new `tools/tests/test_splice.py`.
- **P5: Publish one subreddit.** `check_upload.py merge_one` and a refusal for a cutoff going backwards. `upload_dumps.sh --only KEY` and the publish log. Tests in `test_publish_one.py`.
- **P6: Pruner.** `tools/prune_dumps.py` plans deletions; `prune_dumps.sh` is a dry run by default and runs `rclone purge` with `--apply`. Tests in `test_prune_dumps.py`.
- **P7a: Orchestrator and config.**
  - `tools/archive.json`: `{subreddits: {<name>: {cadence}}, overlap: "2h", repair_days: 7, repair_every: "7d", budget}`.
  - `tools/archive_sync.py`: which subreddits are due or need a repair.
  - `tools/archive_sync.sh`: for each due subreddit, download the live build, fetch, splice and publish; then prune.
- **P7b: Workflow and docs** (owner, `ack:sensitive`).
  - `archive-sync.yml`:
    - hourly cron plus dispatch;
    - `permissions: {}`, and `contents: read` for the job;
    - `environment: archive`;
    - gated on `vars.ARCHIVE_SYNC_ENABLED` and `main`;
    - `concurrency` without cancel;
    - no caches;
    - pinned, checksummed rclone and a pinned duckdb;
    - no AI steps.
  - Docs: CLAUDE.md Commands and rules, `archive.md`, `docs/archive-runbook.md` (closes #57), and WORKFLOW.md's token line.
  - Go-live:
    1. create the token (`rpp-db` only) and the environment;
    2. dispatch a dry run;
    3. run hasan_piker;
    4. enable the sync.
- **P8a: Lifetime benchmark.** `tools/lifetime_bench.mjs`, which the owner runs. Gate: at least 99% agreement, no slower, and no more slow-downs.
- **P8b: Interactions first** (gated).
  - `lifetimeCounts` tries `interactionCounts` first, behind a `buildProfile` option that `app.js` turns on.
  - `estimateScan` takes per-user costs.

**Order and constraints:**
- P0 first. P1 → P2 bring the page gains, even with hand-made builds.
- The sync runs P1 → P3 → P4 → P5 → P6 → P7a → P7b; P5 can run in parallel with P3 and P4.
- P8 can go any time.
- Owner-only paths: `.github/`, `.claude/`, CLAUDE.md and `docs/adr/`. Agents put tests in new files.
- Nothing changes FORMAT/DUMP_FORMAT.

## Verification

- **Each PR:**
  - `cd web && npm test`
  - `uv run --with duckdb --with pytest pytest tools`
  - `bash .github/scripts/rule-guards.sh`
  - `node --test .github/scripts/tests/*.test.mjs`
  - shellcheck on changed `.sh` files
- **P1, P2 and P8b:** `node web/bench/scan-bench.mjs --base main` shows the drop by endpoint.
- **Tools, offline:**
  1. build from `dumps-src/*.jsonl`;
  2. splice at a cut and compare with a from-scratch build;
  3. `upload_dumps.sh --only` against a local rclone remote;
  4. prune dry run.
- **Live, by the owner:**
  - After P1 and P2, scan a hasan_piker thread with "only": the network log shows only the post request and the tail pages.
  - After P7b:
    1. a dry run, then a real run;
    2. `tools/check_dumps.sh all`;
    3. `comments_to_utc` is within ~1 h of now;
    4. after 72 h, prune removes only replaced builds.
