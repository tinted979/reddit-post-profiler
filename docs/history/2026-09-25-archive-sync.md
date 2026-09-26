> **Status.** Current plan, being built in phases; the decisions are in docs/adr/0005 and 0006. Update this note as phases land.
>
> - **Landed:**
>   - P0 (#72);
>   - P1, the shared tail (#73), and P2, the thread from the archive (#74);
>   - a request breakdown at the end of each scan (#75);
>   - an adaptive tail budget (#76);
>   - every count stopping at the post (#77, docs/adr/0006), which changed P1 and P2 as described below;
>   - P3, the fetcher (#78);
>   - P4, the splice builder (#79);
>   - P5, publishing one subreddit (#80);
>   - P6, pruning (#81);
>   - P7a, the orchestrator and config (#82), and `upload_dumps.sh --only`, the manual path (#83).
> - **Next:** P7b, the workflow (the owner's).
> - **Measured** (live, 2026-09-26): an "only" scan of a 53-commenter r/Hasan_Piker post older than the files went from 60 requests to 2 (the post, and one search for the thread's comments after the files), with no per-user requests.

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

**Expected requests** (estimates made before #77; covered subreddit, build under a day old). Since #77 the tail runs only up to the post, so a post older than the files needs no tail at all, as measured above:

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

- **The request.** Once per scan, for each covered subreddit in play (the post's own, plus covered ones in `only`) whose files end before the post, page:
  `/api/{kind}/search?subreddit=S&after=<files through>&before=<post time>&sort=asc&limit=100&fields=id,author,created_utc[,link_id]`
  - Since #77 (docs/adr/0006) the tail stops at the post, as every count does. It used to run to the present.
  - Clean the rows as `build_dumps.py` does: drop `[deleted]`, `[removed]` and AutoModerator, and de-duplicate by id.
- **The tail extends the archive.** `DumpSource.covers(sub)` reports a `through` moved forward to what the tail completed, and `timestamps()` returns file rows plus tail rows. The existing `beforeFacts`/`archiveLifetime` logic then needs no gap search and no per-user `interactions` once every wanted tail reaches the post.
- **Budget.** Pages are scaled from the post's `num_comments`: about 1 per 50 comments, min 2 and max 20 per kind (`tailBudget`).
  - Since #76, past those pages the tail goes on only if the rate they show projects reaching the post within `tailWorth` pages: about one per thread comment for an `only` scan, half that otherwise, at most 100. That's roughly what asking per commenter would cost instead.
  - If it stops short, `through` moves only as far as the tail got, and per-user requests cover the rest through the existing paths.
  - No manifest change.
- **Failures.**
  - `refusesMore` (busy, 429, network) fails the scan, as `collectCommenters` does (0002).
  - `QueryTimeout` drops the tail, and the per-user path answers.
- **Memory.** The tail is kept in memory per tab, keyed by subreddit and build version. The next queued scan asks only for rows after its high-water mark (a small overlap, de-duplicated by id), and a new build's `through` drops older rows. There are no IndexedDB changes.
- **Shared paging.** Extract `iterThreadComments`' paging (`after = last − 1`, de-dupe by id, stop on 2 stale pages) into `ArcticShiftClient.iterAscending(path, params, pageSize)`. The tail and the sync's fetcher both use it.

### Page: thread from `comments_by_link` (P2)

- **Covered posts older than the files** (since #77, docs/adr/0006). `collectCommenters` takes the post's rows from `comments_by_link` (`$eq` on `link_id`, up to the files' cutoff), plus one `/api/comments/search?link_id=…&after=<that cutoff>` for the comments since, usually one short page.
  - A post newer than the files uses the tree request, as before.
  - Before #77, the thread came from the files plus the tail's comment rows for the post, with no request, once the tail reached the present. The tail now stops at the post, so it no longer holds the thread's comments.
- **Same rules as the tree.** Exclusions and `includeOp` apply the same way, and authors keep their spelling.
- **Manifest.** `parseManifest` accepts `comments_by_link` as an optional file, with no format bump.

### Scheduled sync by splicing (P3–P7)

- **The splice.** Given the live build and a cut C, keep each file's rows with `created_utc <= C`, add the API's rows after C (cleaned the same way), and write a new full build.
  - A normal sync uses C = cutoff − 2 h; the weekly repair uses C = cutoff − 7 days.
  - Rows after C are dropped and fetched again, so nothing is duplicated and no ids are needed.
- **The cutoff means "complete up to"**, per kind. The fetcher asks for rows before a time a minute before it starts (`SETTLE`, so they've had time to be archived), and reports `complete_through`:
  - that time − 1, once paging reaches the end;
  - or, if the budget or an API error stopped it, the newest row's time − 1. That second's rows may be incomplete, so they aren't written.

  The page still subtracts `INGEST_LAG`. The manifest shape doesn't change, so there's no FORMAT/DUMP_FORMAT bump.
- **Backfill** comes from one of two sources:
  - The API: start from an empty base and page ascending, one budget per run. Each run publishes a correct partial build (complete from the start up to its cutoff).
  - An import: build locally from download-tool JSONL, then `upload_dumps.sh --only`.
- **The fetcher,** `tools/fetch_subreddit.mjs` (#78), runs the page's `ArcticShiftClient` in Node:
  - the download tool's search, `/api/{kind}/search?subreddit&after&before&sort=asc&limit=auto`, but with only the `fields` the build reads. `auto` gives 100–1000 rows a page by the server's capacity (API README), so a page under 100 rows is the end;
  - `delay: 1`, one request in flight;
  - `appTag: "reddit-post-profiler-archive"`, and a User-Agent naming the repository;
  - a budget in pages.

  It writes exactly the rows from `--after` to `complete_through` as JSON lines, in the shape `build_dumps.py` reads, plus a result file. Rows are untrusted, so it copies only checked fields.

  When an API error stops it, it keeps what it had and exits 3. `busy` marks a busy or rate-limiting server, or no connection. It never escalates.
- **Publishing one subreddit** is split between the jobs:
  - `build` merges the new entry into the **live** manifest. Versions are named `YYYY-MM-DDTHHMMSSZ`.
  - `publish_build.sh` then:
    1. re-fetches the live manifest, and aborts if its sha256 changed;
    2. uploads only `r/KEY/<version>/`;
    3. checks the new files with plain curl range requests;
    4. uploads the manifest last;
    5. uploads the updated `r/KEY/published.json`.
  - `upload_dumps.sh --only KEY` runs the same steps on the owner's machine.
- **The token** is held only by a separate `publish` job. That job runs one security-reviewed shell script, `tools/publish_build.sh`, using only curl, sha256sum and rclone, with no Node, uv or Python.
  - It isn't enough to hide the token from other programs in the same job, because they can read each other's environment (`/proc/<pid>/environ`). Today's `upload_dumps.sh` and `check_dumps.sh` also run Node (including `web/dumps.js`) and Python. So the boundary is a job boundary. The workflow has three jobs:
    1. **`build`** (no secrets): download the live manifest and build through the public URL; fetch; splice; merge the manifest and check it with `parseManifest`; plan prunes; record the live manifest's sha256. Its output is an artifact.
    2. **`publish`** (environment `archive`): `publish_build.sh` on that artifact.
    3. **`verify`** (no secrets): `check_dumps.sh manifest cors`.
  - The artifact is untrusted data: it could deface the archive, which the page treats as untrusted, but it can't reach the token.
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
  - ADR 0002's status notes that 0005 partly supersedes it (the sync's own tag, and scheduled API calls).
  - No `review-route.sh` change is needed: the token-holding job runs only `tools/*.sh`, which is already security-reviewed.
  - WORKFLOW.md's "the R2 token never touches GitHub" changes in P7b, when that stops being true.
- **P1: Shared tail in the page.**
  - `core.js`: `iterAscending`, which `iterThreadComments` delegates to; `fetchTail`; and `archiveLifetime` skips `interactions` when every tail reaches the post (since #77; before it, the present).
  - `dumps.js`: `addTail`, an extended `covers()`, `timestamps()` merging file and tail rows, and a per-tab `TailCache`.
  - `app.js`: fetch the tails after the post and manifest, with `runId` checked after each await.
  - Tests: new `web/tests/tail.test.js`, plus `dumps.test.js`. Bench scenarios: "build N days old", "25-link queue", "`only` covered".
  - Docs: README, and the help text using `data-const`.
- **P2: Thread from `comments_by_link`** (closes #55). `dumps.js` gets `threadRows(sub, linkId)`; `collectCommenters` takes a covered-post path and falls back to the tree. Tests and bench.
- **P3: Fetcher** (#78). A `core.js` `appTag` option and `tools/fetch_subreddit.mjs`. Tests in a new `web/tests/fetch-subreddit.test.js`.
- **P4: Splice builder** (#79). `build_dumps.py --splice <dir> --cut <utc>`, `--posts-through/--comments-through` and timestamp versions. The JSONL-only mode is unchanged. Tests in a new `tools/tests/test_splice.py`.
  - `<dir>` is laid out like the archive: the live `manifest.json`, plus the subreddit's live build under `r/<key>/<version>/`. P7a downloads both through the public URL.
    - The downloaded build is checked as untrusted before use: the version name, file paths rebuilt from key and version, sizes against the manifest, and columns.
    - With `--out <dir>`, the new build lands next to the old one, and the manifest is the live one with this subreddit's entry replaced. That's the merged manifest P5 publishes.
  - The build files have no ids, so each file is spliced separately: its rows up to the cut, plus the fetched rows after it, cleaned as `load()` cleans any JSONL. The two meet at the cut, so nothing appears twice.
  - The cutoffs are the fetcher's `complete_through`, so the manifest's `*_to_utc` now mean "complete up to", not the newest item. The files' `from_utc`/`to_utc` stay the newest and oldest rows.
  - It refuses:
    - a cut after either live cutoff, since what's between would be in neither build;
    - a new cutoff earlier than the live one;
    - a cutoff in the future.
  - `--posts-through/--comments-through` also work without `--splice`, for a subreddit's first build fetched from the API: rows after them are left out.
  - Checked offline end to end: fetch, build, fetch more and splice gave the same rows, in file order, as one fresh build of everything, and the page's `DumpSource` read them back.
- **P5: Publish one subreddit** (#80).
  - `check_upload.py merge-one` needs no token. It takes this subreddit's entry into the live manifest, so the other entries stay as they are live, and writes the bundle `publish_build.sh` uploads (`key`, `version`, `live.sha256`, `manifest.json`, the build's files, and the log). The log's entries are `{version, replaced, utc}`, so P6 can tell when each build was replaced.
  - `publish_build.sh` reads the live manifest's sha256 through rclone, not the public URL, whose edge cache can lag. It checks it again just before replacing the manifest.
  - `upload_dumps.sh --only KEY` moved to P7a. It calls rclone and curl directly, so testing it needs them injectable, as P7a's scripts will be. Until then, the manual path is `merge-one` followed by `publish_build.sh`.
  - Plan as written: It refuses a cutoff that goes backwards or a version that's already live. It writes the merged manifest, the updated publish log, and the live manifest's sha256.
  - `tools/publish_build.sh` uses only curl, sha256sum and rclone. It checks KEY, VERSION and every path against strict patterns before any rclone call.
  - `upload_dumps.sh --only KEY` covers the manual path.
  - Tests: `test_publish_one.py`. The shell script is tested with rclone and curl injected through `RCLONE`/`CURL` variables, never PATH-shadowed.
- **P6: Pruner** (#81). Built more simply than planned, with no `prune_dumps.py`.
  - Each publish prunes its own subreddit's replaced builds, planned by `merge-one` from the publish log it already reads:
    - replaced at least 72 h ago;
    - not the live or new build;
    - at most 5, oldest first;
    - recorded in the log's `pruned`, so none is planned twice.

    Every subreddit publishes on its cadence, so its old builds go at the next publish after 72 h.
  - `publish_build.sh` deletes them after the manifest and log are up, keeping any build the replaced manifest named. When it prunes, it also lists `r/<key>/` and reports builds the log doesn't know, for deleting by hand.
  - Tests: `tools/tests/test_prune.py`.
  - Plan as written:
  - `tools/prune_dumps.py` plans deletions from the live manifest and the public publish logs. It needs no token and no listing.
  - `publish_build.sh` applies the plan. It deletes at most N builds per run, and only paths shaped `r/<key>/<version>/` that neither the old nor the new manifest mentions (checked with `grep -F`).
  - Tests: `test_prune_dumps.py`.
  - The PR's Grounding proposes the prune rule for CLAUDE.md's "Dump tools" rule and `archive.md` (builds are never overwritten, and are deleted only as 0005 says).
- **P7a: Orchestrator and config** (#82). Built in Python rather than shell: the build job holds no token, and Python is much easier to test.
  - `tools/archive_sync.py plan|build` decides what's due and makes the bundles:
    - **sync:** after the subreddit's cadence (less 15 min of slack for cron), from the older cutoff less `overlap`;
    - **repair:** once `repair_every` has passed since the last repair, from `repair_days` before the older cutoff. Repairs are marked in the publish log (`merge-one --repair`), and only a caught-up subreddit repairs;
    - **first build:** from the API only with `"backfill": "api"`; otherwise it's skipped and needs an import.
  - **For each due subreddit,** `build` downloads the live build, runs the fetcher for each kind, splices, and runs `merge-one` into `bundles/NN-<key>/`.
    - Several bundles chain: each is merged onto the manifest the previous one leaves live. The publish job publishes them in order and stops at the first failure.
    - A busy server stops the fetching and keeps the bundles already made.
    - A refused splice or merge skips that subreddit.
    - `run_budget` (600 pages) caps every fetch in a run together, as ADR 0005's "request budget per run" says; `budget` (300) caps each fetch.
  - **Checked offline end to end on real data** (a fake fetcher, a local bucket):
    1. `plan` read the live archive;
    2. `build` downloaded the real r/Hasan_Piker build (131k posts, 1.47M comments) and spliced onto it;
    3. `publish_build.sh` published the bundle to the fake bucket.
  - `upload_dumps.sh --only` came as its own small PR (#83). Its rclone, curl and `check_dumps.sh` can now be injected, and it has its first tests.
  - Plan as written:
  - `tools/archive.json`: `{subreddits: {<name>: {cadence}}, overlap: "2h", repair_days: 7, repair_every: "7d", budget}`.
  - `tools/archive_sync.py`: which subreddits are due or need a repair.
  - `tools/archive_sync.sh`: the `build` job's work. For each due subreddit it downloads the live build over the public URL, fetches, splices, merges the manifest and plans prunes, then writes the artifact.
  - `upload_dumps.sh --only KEY` (moved from P5): the owner's manual path. It runs `merge-one` on a local build, then `publish_build.sh`, with rclone and curl injectable for its tests.
- **P7b: Workflow and docs** (owner, `ack:sensitive`).
  - `archive-sync.yml`:
    - hourly cron plus dispatch;
    - `permissions: {}`, and `contents: read` per job;
    - three jobs: `build` (no secrets), `publish` (`environment: archive`, runs only `publish_build.sh`) and `verify` (no secrets);
    - the environment's deployment-branch rule allows only `main`;
    - also gated on `vars.ARCHIVE_SYNC_ENABLED` and the ref;
    - `concurrency` for the whole run, without cancel;
    - no caches;
    - pinned, checksummed rclone and a pinned duckdb;
    - no AI steps.
  - Docs:
    - CLAUDE.md Commands and rules;
    - `archive.md`;
    - `docs/archive-runbook.md` (closes #57);
    - WORKFLOW.md's token line;
    - `.claude/rules/ci-and-agents.md`: the new workflow and environment.
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
  - After P1 and P2, scan a hasan_piker thread with "only":
    - for a post older than the files, the network log shows the post request and one thread search (seen 2026-09-26: 2 requests);
    - for a newer post, the post request, tail pages up to the post, and the comment tree.
  - After P7b:
    1. a dry run, then a real run;
    2. `tools/check_dumps.sh all`;
    3. `comments_to_utc` is within ~1 h of now;
    4. after 72 h, prune removes only replaced builds.
