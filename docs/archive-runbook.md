# Archive runbook

This is how the R2 archive (bucket `rpp-db`, served at https://rpp-db.tinted979.dev) is kept current, and what to do when something needs a hand.
- **Why it's built this way:** docs/adr/0004 (a static archive), 0005 (its scheduled sync) and 0006 (counts stop at the post).
- **What each tool does:** `.claude/rules/archive.md`.

## What runs

- **Hourly, `.github/workflows/archive-sync.yml`**, while `ARCHIVE_SYNC_ENABLED` is `true` (on since 2026-09-26; see "Pausing").
  - **Each run:** for every subreddit in `tools/archive.json` that's due, it:
    1. fetches what's new from Arctic Shift;
    2. splices that onto the live build and publishes a new build;
    3. deletes builds that were replaced at least 72 h ago.
  - **Each week,** each subreddit re-fetches its last 7 days, to catch items Arctic Shift archived late.
  - **The token:** only one step of one job, `publish`, sees it. That step runs only shell: rclone, curl, sha256sum and standard tools.
- **Weekly, `.github/workflows/archive-check.yml`:** checks the archive serves the page what it needs (the manifest, CORS, range reads).
- **By hand:** first imports of big subreddits, and the jobs below.

## Setting up the sync (once)

1. **Make a token for the bucket only.**
   - In Cloudflare, go to R2 → Manage API tokens → Create API token, with Object Read & Write, applied to `rpp-db` only.
   - Keep three things: the access key id, the secret, and the account's S3 endpoint, `https://<account-id>.r2.cloudflarestorage.com`.
2. **Make the `archive` environment.** On GitHub, go to Settings → Environments → New environment, and call it `archive`.
   - **Deployment branches and tags:** choose "Selected branches and tags" and add `main`, so no other branch can run with the token.
   - **Environment secrets:** add `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_ENDPOINT`, only after the branch rule above is saved.
   - **Never add them as repository secrets.** Secrets with the same names at the repository level would reach any branch, where the `main`-only rule wouldn't cover them.
   - **Required reviewers:** none, since it runs hourly.
3. **Do a dry run.** Go to Actions → Sync the archive → Run workflow, on `main`, with mode `dry-run`.
   - It calls Arctic Shift, fetches and builds, but publishes nothing.
   - The build job's summary lists what it built and what it skipped.
4. **Do one real run for one subreddit:** mode `sync`, subreddit `Hasan_Piker`. Then check from your machine:
   - `tools/check_dumps.sh all` passes;
   - the manifest's `comments_to_utc` is within about an hour of now.
5. **Turn the schedule on.** Go to Settings → Secrets and variables → Actions → Variables, and set `ARCHIVE_SYNC_ENABLED` to `true`.

## Reading a run

The build job's summary has:
- a line for each subreddit it built: the mode, and the posts and comments fetched;
- a line for each subreddit it skipped, and why;
- the pages fetched, and whether Arctic Shift was busy.

| You see | It means | What to do |
|---|---|---|
| `not due` | Its cadence hasn't passed yet. | Nothing. |
| `Arctic Shift was busy` | A fetch got "slow down" or 429 replies, so the run stopped fetching. It never retries harder. | Nothing: the next run tries again. |
| `the run budget … is spent` | `run_budget` pages were used up, so the rest wait for the next run. | Nothing, unless it keeps happening. Then raise `run_budget` modestly: Arctic Shift is a free, shared service. |
| `… is earlier than the live build's … cutoff` | The fetch stopped short of the live build's cutoff (its budget, or an error), so the live build stays. | If it keeps happening for one subreddit, it's too busy for the budget: raise `budget`, or make its cadence shorter so each run has less to fetch. |
| `isn't in the archive yet` | It's listed, but has no build and no `"backfill": "api"`. | Import it (below). |
| publish: `the live manifest changed since this bundle was made` | Another upload (yours, say) landed between build and publish. | Nothing: the next run builds from the new manifest. |
| publish: `not every build due was pruned` | The new build is live, but the builds named above it weren't deleted. They're recorded as pruned and won't be tried again. The run's later bundles aren't published and `verify` doesn't run; the next run builds them again. | Delete them by hand if you like (see "Builds on R2"). |
| verify fails | The new build is live, but the page may not read it right. | Run `tools/check_dumps.sh` yourself, and see the Hosting notes in `.claude/rules/archive.md`. |

## Adding a subreddit

- **A small one** (up to a few thousand items a day, with little history):
  - Add `"Name": {"cadence": "1h", "backfill": "api"}` to `tools/archive.json` and merge.
  - The sync then builds it from its start over several runs, `budget` pages at a time, after the subreddits that are caught up.
  - That's a lot of requests to a free service, so import anything big instead.
- **A big one** (r/Hasan_Piker's history is about 16k pages): import it.
  1. Download its posts and comments as JSONL with Arctic Shift's download tool: https://arctic-shift.photon-reddit.com/download-tool.
  2. `uv run tools/build_dumps.py --subreddit Name --posts r_Name_posts.jsonl --comments r_Name_comments.jsonl --out dumps-new`
  3. `tools/upload_dumps.sh dumps-new --only name`. This publishes just that subreddit into the live manifest, and every other entry stays as it is.
  4. Add it to `tools/archive.json`, without `backfill`, and merge. The sync takes it on from its cutoff.

  The download tool starts each page at the last item's time. So an item that shares its second with the end of a page can go missing, and the weekly repair only reaches 7 days back. That's a handful of items, too few to change counts.
- **Stopping one:** take it out of `tools/archive.json`.
  - Its live build then stays in the manifest, still correct up to its cutoff, and the page still uses it for scans before that.
  - To drop it from the manifest too, make a whole upload with `--drop key`, from a directory that holds the live `manifest.json` and every other subreddit's live build. A whole upload refuses a stale build whose cutoff is older than the live one's ("is earlier than the live build's"); `--allow-older` overrides that.

## Forcing a run

Dispatch the workflow on `main`:
- **`plan`:** says what's due, without fetching anything;
- **`dry-run`:** builds without publishing;
- **`sync`:** builds and publishes.

With a subreddit named, it builds just that one, due or not. Tick "repair" to re-fetch its last `repair_days`. `budget` overrides the pages per fetch.

## Pausing

- **Scheduled runs:** set `ARCHIVE_SYNC_ENABLED` to anything but `true`. Dispatches still work.
- **Everything:** disable the workflow on the Actions tab.
- **After 60 days** without repository activity, GitHub disables scheduled workflows. Re-enable it on the Actions tab.

## Builds on R2

- **The publish log:** each publish is logged in `r/<key>/published.json`, a public file listing which build it replaced and when.
- **Pruning:**
  - A build is deleted by the first publish at least 72 h after the one that replaced it, at most 5 per publish. `publish_build.sh` checks the 72 h against R2's own log, not only the bundle's list.
  - Never deleted: a build a manifest names, or one the log doesn't know.
- **Builds the log doesn't know** are only reported: a publish that prunes lists them as "neither live nor in the publish log". Examples:
  - hand uploads from before the sync;
  - a publish that uploaded its files and then stopped.

  To deal with one:
  1. List a subreddit's builds: `rclone lsf --dirs-only r2:rpp-db/r/<key>/`.
  2. Check that neither the live manifest (`curl -s "https://rpp-db.tinted979.dev/manifest.json?check=$(date +%s)"`, past the edge cache) nor anything you're about to upload names it.
  3. Delete it: `rclone purge r2:rpp-db/r/<key>/<version>`.
- **A half-finished upload:** both `upload_dumps.sh` and the sync upload build files first and the manifest last. So a stop in between leaves unreferenced files, which does no harm.
  - Running it again refuses the same version: a whole upload with "already exists on R2", an `--only` run or a sync publish with "already on R2". Rebuild with a new `--version`, or let the next sync run do it.

## Rotating the token

1. Make a new token, as in setup step 1.
2. Replace the three `archive` environment secrets. Also update your own rclone config: `rclone config update r2 access_key_id=… secret_access_key=…`.
3. Dispatch a `sync`, or wait for the next run, and check that it publishes.
4. Revoke the old token in Cloudflare.

## Updating rclone and duckdb

- **Actions** in the workflows are pinned to commits, and Dependabot bumps them.
- **rclone** (the publish job) and **duckdb** (the build job) are pinned in `archive-sync.yml` and bumped by hand.
  - **For rclone,** set `RCLONE_VERSION` and `RCLONE_SHA256`. The checksum is the `rclone-v<version>-linux-amd64.zip` line of the release's SHA256SUMS: `gh release download v<version> -R rclone/rclone -p SHA256SUMS -O -`. Download the zip and check it with `sha256sum` too.
  - **For duckdb,** set `DUCKDB_VERSION`, and run the tool tests with that version first: `uv run --with "duckdb==<version>" --with pytest pytest tools`.

## Updating hyparquet

`web/hyparquet.js` is hyparquet's jsDelivr `+esm` build, saved with its license header added. It's never edited, and it's a protected file (`ack:sensitive`).
- **Where it comes from:** `https://cdn.jsdelivr.net/npm/hyparquet@<version>/+esm`. The version is in the header, currently 1.31.1.
- **To check the saved copy against its source** (this prints nothing when they match):

  ```sh
  diff <(tail -n +11 web/hyparquet.js | tr -d '\r') \
       <(curl -fsSL https://cdn.jsdelivr.net/npm/hyparquet@1.31.1/+esm | grep -v '^//# sourceMappingURL=')
  ```

  For 1.31.1, the code after the header hashes to `4d7f0e1897f7f69924dceac300a477b855ec4a1c257c82cafce15b1f2b701872` (`tail -n +11 web/hyparquet.js | tr -d '\r' | sha256sum`). Checked 2026-09-26.
- **To update:**
  1. Download the new version's `+esm` and drop its `sourceMappingURL` line.
  2. Put the license header back, with the new version.
  3. Run the web tests, and try a scan in the browser.
