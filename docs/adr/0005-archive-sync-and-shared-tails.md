# 0005. Keep the archive current with a scheduled sync, and share each subreddit's tail

**Status:** Accepted (recorded 2026-09-25; plan in docs/history/2026-09-25-archive-sync.md). Supersedes 0004.

## Context

The archive in 0004 was built by hand, so it fell behind. The thread being scanned is nearly always newer than the build, so each commenter still asked the API about the gap after it. The bench's archive case cost 4 requests, the same as no archive. Yet that gap is the same window, in the same subreddit, for every commenter.

A live check (2026-09-25) found that subreddit-wide search:
- pages at 100 rows;
- answers in about a second, even on r/AskReddit.

r/Hasan_Piker's ~1,900 comments a day are 1 page an hour, or ~20 a day.

The per-subreddit torrents were taken down in July 2026, so for chosen subreddits the API is the only source. Reddit's full monthly dumps (~75 GB) don't fit a hosted runner and are more than chosen subreddits need. A private copy with ids was weighed against splicing onto the public build. It would be safer and could hold text, but needs a second bucket and more tooling.

## Decision

Everything in 0004 still holds, except the following.

- **Scheduled sync.** `.github/workflows/archive-sync.yml`, which is not an agent workflow, updates each subreddit in `tools/archive.json` on its own cadence.
  - It fetches through the page's `ArcticShiftClient`, one request at a time, tagged `meta-app=reddit-post-profiler-archive`, within a request budget per run.
  - Each new build splices the live build's rows up to a cut onto the API's rows after it. The cut is 2 h before the cutoff, or 7 days before it once a week, to catch items ingested late.
  - A cutoff means "complete up to", not "newest item".
  - Builds are published one subreddit at a time into the live manifest, manifest last.
- **The token.** An R2 token with Object Read & Write on `rpp-db` only lives in the `archive` environment, which only `main` can use. Only `tools/*.sh` scripts receive it, and they pass it only to rclone.
- **Pruning.** A build is deleted once all of these hold:
  - it isn't live;
  - it isn't its subreddit's newest;
  - the publish that replaced it, logged in `r/<sub>/published.json`, is at least 72 h old.

  Builds that aren't logged are never deleted.
- **The page shares the gap.** For each covered subreddit in play, the page fetches the activity after the cutoff once per scan and keeps it for the tab, rather than once per commenter. It pages within a budget and stops at what it covered. It also reads the thread from `comments_by_link`. If the server is busy, the scan fails rather than falling back to per-user requests (0002).
- **No text** is stored.

## Consequences

- **Fewer requests.** For covered subreddits, an "only" scan costs a few requests in total instead of about one per commenter, and a covered post needs no comment-tree request.
- **The token is now in GitHub.** A leaked token could overwrite or delete the public archive, but there's nothing private to read. Mitigations:
  - an environment only `main` can use;
  - no caches, and pinned tools;
  - only shell scripts see the token;
  - a kill switch, the `ARCHIVE_SYNC_ENABLED` variable.
- **The archive holds only what the API served.**
  - Items ingested more than 2 h late are missing until the weekly repair.
  - A bad splice carries forward: recover from builds kept 72 h, or re-import.
  - New columns or text mean re-pulling each subreddit's history, at about one request per 100 items.
- **Only modest subreddits suit this.** Much busier subreddits cost many pages per sync and per scan, so cover them with longer cadences or not at all.
- **Revisit if:** Arctic Shift objects to the sync, offers bulk exports, or changes its page size, or if a text feature makes a private copy worth it.
