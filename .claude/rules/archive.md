---
paths:
  - "web/dumps.js"
  - "web/hyparquet.js"
  - "web/tests/dumps.test.js"
  - "web/tests/fetch-subreddit.test.js"
  - "web/tests/fixtures/**"
  - "tools/**"
---
# The subreddit archive: dumps.js, hyparquet.js and tools/

Moved from CLAUDE.md (web app architecture and Subreddit dumps). Why it's built this way: docs/adr/0005 (which supersedes 0004).

- **`dumps.js`:** `DumpSource`: loads the archive manifest from `https://rpp-db.tinted979.dev` (checked as untrusted input: subreddit names, each file under its own `r/<key>/`, no cutoff more than a day past the page's clock), says which subreddits it covers, and reads one author's timestamps from a Parquet file with hyparquet range requests. A failed read switches it off for the rest of the scan; Stop throws `Aborted`. `open({ onRequest })` calls `onRequest` once per request sent to the archive server (the manifest, even when it gives no archive, and each range read), which `app.js` counts. `core.js` doesn't import it: `buildProfile(…, { dumps })` calls `covers`/`timestamps` and bumps `lifetimeReads` (and `lifetimeGaps`, when Arctic Shift filled a gap before the post) for the end-of-scan note.
  - **Tails:** `TailStore` (one per tab, from `app.js`) keeps each covered subreddit's activity after its files end, up to the posts scanned (counts stop at the post, docs/adr/0006), which `core.js`'s `fetchTails` adds with `addTail`/`endTail`. It keys each tail by the files' cutoff, so a new build starts afresh. `tailFrom` restarts an hour before where a tail was complete, with repeats dropped by id. `covers` reports each kind's cutoff moved forward to its tail (or the files' alone with `withTail: false`), `timestamps` returns file rows up to the files' cutoff plus tail rows, and `threadRows` a thread's rows up to the files' cutoff from the optional `comments_by_link` file (keyed by `link_id` without `t3_`). Tail rows are untrusted API data: ones without an id, author or time, by deleted accounts or AutoModerator, dated more than a day past now, or already seen are dropped.
- **`hyparquet.js`:** a saved copy of hyparquet 1.31.1's bundled build (MIT). Don't edit it; update it by downloading a new `+esm` build as its header describes.

## Subreddit dumps

Arctic Shift's per-subreddit dumps are served as static Parquet on Cloudflare R2 (`dumps.js`). For a covered subreddit the page takes "before" facts from the files plus a tail up to the post fetched once per scan (docs/adr/0005, 0006), and for a scan limited (`only`) to covered subreddits, lifetime counts too; only when those stop short of the post does it ask per user (one `interactions` query for the rest). Otherwise lifetime counts come from the API, since a subreddit's dump doesn't cover the rest of Reddit. For a post older than the files, the thread's commenters come from `comments_by_link` plus one search for the thread's comments since; for a newer post, from the API's comment tree. The page's privacy text (README and `index.html`) names the archive host; keep it true if what the page reads changes.

- `tools/build_dumps.py` (Python, DuckDB via `uv`) turns a subreddit's posts and comments JSONL into `posts_by_author`, `comments_by_author` (lowercase author, `created_utc`; sorted by author) and `comments_by_link` (`link_id` without `t3_`, author as written, `created_utc`), plus `manifest.json` (format version, and per subreddit the build directory and `posts_to_utc`/`comments_to_utc`, the cutoffs the files are complete up to: the newest item for a build from JSONL alone, or `--posts-through`/`--comments-through` when given). It keeps no text, drops deleted accounts and AutoModerator, and de-duplicates by id. Builds go in `r/<sub>/<version>/` and are never overwritten; only the manifest changes.
  - **`--splice DIR --cut C`** (the archive sync, docs/adr/0005): DIR is laid out like the archive (the live `manifest.json`, and the subreddit's build under `r/<key>/<version>/`).
    - The new build keeps each of that build's files' rows up to C and adds the fetched JSONL's rows after it, cleaned the same way. They meet at C, so nothing is in both, and no ids are needed (the files have none).
    - Its cutoffs are `--posts-through`/`--comments-through` (the fetcher's `complete_through`, both required), and its version is when it was built (`YYYY-MM-DDTHHMMSSZ`).
    - The downloaded build is untrusted: its version, its paths (rebuilt from key and version, not followed), sizes and columns are checked first.
    - It refuses a cut after either live cutoff (a gap), a cutoff earlier than the live one, or one in the future.
    - With `--out DIR` the new build lands beside the old, and DIR's manifest becomes the live one with this entry replaced.
    - Tests: `tools/tests/test_splice.py`.
- `tools/fetch_subreddit.mjs` (Node 22+) fetches one subreddit's posts or comments after a time, for the scheduled sync (docs/adr/0005).
  - **How it asks:** the same search as Arctic Shift's download tool, `/api/{kind}/search?subreddit&after&before&sort=asc&limit=auto`, but with only the `fields` the build reads.
    - `limit=auto` is 100–1000 rows a page by the server's capacity (API README), so a page under 100 rows ends it (`iterAscending`'s `shortBelow`).
    - It goes through the page's `ArcticShiftClient` (its pacing and backoff): `delay` 1 s, one request in flight, `appTag` `reddit-post-profiler-archive`, a User-Agent, and a budget in pages.
  - **What it writes:** as JSON lines in the shape `build_dumps.py` reads, exactly the rows from `--after` to `complete_through`, with a result file beside them. `complete_through` is the second before `--before` once it reached the end; otherwise it's the second before its newest row, since that second may be incomplete. `--before` defaults to a minute ago (`SETTLE`) and may not be later.
  - **Untrusted rows:** only checked fields are copied.
  - **Errors:** an API error stops it with what it had (exit 3), with `busy` set for a busy or rate-limiting server or no connection. It never escalates.
  - **Tests:** `web/tests/fetch-subreddit.test.js`, against a fake API.
- Publishing one subreddit (the archive sync, docs/adr/0005) takes two steps, so that the token is held only by the second:
  - **`tools/check_upload.py merge-one`** (no token) merges `r/<key>`'s entry from a build's `manifest.json` into the live manifest, downloaded byte for byte. Every other entry stays as it is live, so a stale or partial `dumps/` can't change them.
    - It refuses: a version that's live or already in the publish log; a missing file, or a size that differs; a cutoff in the future, or earlier than the live one (unless `--allow-older`); a format change; and a publish log that doesn't check out.
    - It writes a bundle: `key`, `version`, `live.sha256`, the merged `manifest.json`, the build's three files, and `r/<key>/published.json`.
    - The publish log is `{format, subreddit, publishes: [{version, replaced, utc}], pruned: [version]}`, oldest first, keeping its newest `LOG_KEEP` (1000); `pruned` appears once there are any.
    - **Pruning is planned here, per subreddit, at each publish:** the builds the log says were replaced at least `PRUNE_AFTER` (72 h) ago, never the live one or the new one, at most `PRUNE_MAX` (5), oldest first. They go into the log's `pruned`, so none is planned twice, and into the bundle's `prune` file.
  - **`tools/publish_build.sh BUNDLE`** uses rclone, curl, sha256sum and coreutils only. `RCLONE`/`CURL` can name fakes, which the tests use.
    - It treats the bundle as untrusted: regular files only, exactly the expected names, a key, a version and a sha256 matching strict patterns, and a manifest that names the new build, all checked before any rclone call.
    - Then, in order:
      1. the live manifest on R2 (read with rclone, not through the cache) still has the bundle's sha256;
      2. the build isn't on R2 yet;
      3. the build files go up (`--immutable`, cached a year);
      4. each file is range-checked through the public URL;
      5. the live manifest is checked again, then the new one goes up (5 minutes);
      6. the publish log (5 minutes);
      7. last, it deletes the builds in `prune` (`rclone purge`). The list is only a request, so it keeps:
         - a build the replaced manifest named;
         - a build the publish log on R2 doesn't record as `"replaced": "<version>"`. That log is read at step 1, before this publish replaces it, so a bundle can't vouch for itself.

         A build that's already gone is fine.
         - It then lists `r/<key>/` and reports builds that are neither live nor in the log; those are never deleted automatically.
         - A failed prune fails the script after the publish stands.
       - The `prune` list itself is checked before any rclone call: at most 5 lines, each a version, not the new build, and not named by the new manifest.
    - Tests: `tools/tests/test_publish_one.py` and `test_publish_build.py`.
- Hosting: R2 bucket `rpp-db`, served at `https://rpp-db.tinted979.dev` (custom domain, proxied, with a Cache Rule making it eligible for cache). Its CORS policy is `tools/r2-cors.json`: GET/HEAD from the Pages origin and `localhost:8000`, `Range` allowed, `Content-Range`/`Content-Length`/`Accept-Ranges`/`ETag` exposed. If the page moves origin, add the new one there and in the bucket settings. R2 applies CORS after the edge cache (checked live): a cache HIT still gets `Access-Control-Allow-Origin` for the requesting origin only, with `Vary: Origin`. The bucket's `r2.dev` URL stays disabled so all reads go through the cache.
- Zone settings for this host: Smart Tiered Cache on (misses fill from an upper-tier colo rather than R2); minimum TLS 1.2 on the zone and the R2 custom domain; a Configuration Rule for `http.host eq "rpp-db.tinted979.dev"` turning off Browser Integrity Check (the new security dashboard has no threat-score Security Level left to lower), because a challenge page on a cross-origin `fetch` shows up as a CORS error, switches `DumpSource` off and sends the scan back to the API. For the same reason Bot Fight Mode is off (zone-wide on the Free plan; the zone serves only this host): it gave GitHub's runners a managed challenge, so the weekly `archive-check` workflow got 403s, and it could do the same to a visitor on a VPN or cloud network. The managed WAF rules, which block scanners, stay on. Before changing a zone security setting, check that a scheduled `archive-check` run still passes.
- `tools/upload_dumps.sh` first runs `tools/check_upload.py` against the live manifest and R2's build list: the uploaded manifest replaces the live one whole, so it refuses one that drops a live subreddit (unless `--drop KEY`), a new build whose `r/<sub>/<version>/` already exists on R2, the live version rebuilt with different files, or a format change (unless `--allow-format-change`). Then it uploads build files (`immutable`, a year, never replaced) and checks them with `tools/check_dumps.sh files`; only then does it upload the manifest (5 minutes) and run `check_dumps.sh manifest` and `cors`. It never deletes: old builds stay until removed by hand (the sync's `publish_build.sh` prunes its own, as above). The rclone token is limited to Object Read & Write on the bucket and stays out of the repo.
- `tools/check_dumps.sh` checks, reading public URLs only: that the live manifest is readable from the page's origin and no other, and that the page's own `parseManifest` accepts every subreddit in it (one it ignores would quietly send those scans to the API); that a range preflight passes from every origin in `tools/r2-cors.json` and fails from others (so that file is checked against the bucket, not just recorded); and that each file answers a range request with 206, its full size in `Content-Range`, CORS, `Content-Range` exposed, and no `Content-Encoding`.
- Files are Snappy-compressed (hyparquet reads Snappy with no extra package) in ~10k-row groups. Measured on r/Hasan_Piker (131k posts, 792k comments): 1.3 MB, 5.8 MB and 10.6 MB; one user's comments read 71 KB and a 1,922-comment thread 285 KB, plus a 64 KB footer read.
- For the browser, [hyparquet](https://github.com/hyparam/hyparquet) skips row groups by min/max statistics only for operator filters: `filter: { author: { $eq: name } }`. A plain `{ author: name }` gives the right rows but reads the whole file. Pass `initialFetchSize: 64 * 1024` to `parquetMetadataAsync`; the default reads the last 512 KB.
