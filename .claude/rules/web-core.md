---
paths:
  - "web/core.js"
  - "web/tests/core.test.js"
  - "web/bench/**"
---
# web/core.js: the API client and profiling

Moved from CLAUDE.md's web app architecture. The API's verified behaviour is in arctic-shift-api.md.

- **`core.js`** contains all API and profiling logic. It has no DOM access and is tested in Node.
  - **`ArcticShiftClient`:**
    - Spaces request starts by `delay` using a slot scheduler.
    - Caps requests in flight with AIMD: the cap halves on a 429, a "slow down" reply, a 5xx or a network error, and grows back after `GROW_AFTER` successes. The retry waits are the `BACKOFF` table; a request's own waits are jittered (`JITTER`).
    - Every request carries `meta-app=reddit-post-profiler` (`APP_TAG`), so Arctic Shift's maintainer can identify the traffic.
    - A 429 or a network error pauses every request on the client (`_pause`, reported via `onPause`). Per-request backoffs are reported via `onWait`.
    - After repeated "slow down" replies it throws `ServerBusy` instead of escalating to heavier queries, and pauses every request on the client for `BACKOFF.busy` (60 s), so the next users don't start their own rounds of retries. The parts of a split (`subredditCounts`) share a group: its slow-downs are counted together, and once one part gives up on a server that won't answer (`refusesMore`, or a lasting 5xx; its 5xx replies are counted together too), the unsent parts are dropped with that part's error (measured: 102 requests to a busy server for one timed-out user before, 7 now).
    - Stop works through an `AbortSignal` that also wakes any sleep in progress.
    - `fetchFn`, `sleep`, `now` and `random` can be injected. The tests use a fake clock this way (`makeClient` in `tests/core.test.js`) and read the scheduler through `stats()` (`{limit, inFlight, waiting}`) rather than private fields.
  - **Commenters:** `collectCommenters` fetches the whole thread in one `/api/comments/tree` request. It falls back to paging `/api/comments/search` if the tree has `more` stubs, fails, or the thread has at least `TREE_LIMIT` comments; a busy or rate-limiting server, or no connection, fails the scan instead, since paging would only send it more requests.
  - **`buildProfile`:**
    - Lifetime counts come from two parallel `/api/{posts,comments}/search/aggregate` calls.
    - If those time out, it falls back to `/api/users/interactions/subreddits`. That endpoint encodes posts×1e6 + comments in one count via `weight_posts`. Only its 4xx refusals (not a 429) count as "can't answer for this user"; a 5xx that outlasts the retries fails the user. After that it falls back to yearly or per-subreddit splits of only the kind that timed out.
    - With `only` limited to subreddits the archive covers, lifetime counts come from the archive up to one cutoff plus a single `interactions` query after it (`after` is exclusive; checked live), cached under their own `lifeonly` keys rather than the full lifetime key, since they only cover the wanted subreddits. If that `interactions` query can't answer, the aggregate fallback above answers instead, without retrying it.
    - "Before" facts (`beforeFacts`) come from timestamp searches (`client.timestamps`: `/api/{kind}/search?fields=created_utc&limit=100`), giving the count, distinct days active and first date in one request per kind; past 100 items the aggregate gives the exact count and an `asc` search the first date, and days become a lower bound (`targetTimelineComplete: false`). If the search fails with an API error (not a busy or rate-limiting server, which fails the user), the aggregate count is used with no timeline, and that answer isn't cached. They're skipped when the lifetime totals already prove the answer. For a subreddit the archive covers, they come from its files up to an hour before their newest item, and the API is asked only about the gap from there to the post; if the files fail, the API answers for the whole window.
    - It reads and writes the optional cache. Lifetime totals are trusted only if fetched at least `INGEST_LAG` after the post and after the user's last comment in the thread.
  - **Badges** (`DEFAULT_BADGES`, `profileFacts`, `activityTier`, `parseBadges`/`formatBadges`, `badgeFacts`/`tierCounts`): new here / occasional / regular from posts+comments, days active and tenure, each with a configurable threshold (0 = off; unknown facts skip their check). Tiers are never stored: `app.js` works them out when rendering from the stored facts, so changing the rules re-rates results and saved scans (their summaries keep `facts`) with no requests.
  - **`estimateScan`** gives a rough request count and time before a scan (from saved lifetime totals). Above `LARGE_SCAN` (300) users, `app.js` asks before profiling them all, unless `max` is set; queued scans take the top 300.
  - **Saved scans as a file** (`exportScans`, `parseScanExport`, `importScan`): imported files are untrusted, so every field is checked, names must match `[\w-]`, and stats and badge facts are recomputed from the profiles.
  - **`Eta`** estimates time left from the recent pace of users that needed requests, leaving out saved results and shared pauses.
