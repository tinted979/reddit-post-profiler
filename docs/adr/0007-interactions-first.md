# 0007. Lifetime counts ask one interactions query first

**Status:** Accepted (recorded 2026-09-26; plan in docs/history/2026-09-25-archive-sync.md, P8).

## Context

A full scan needs each commenter's per-subreddit post and comment counts, up to the post
(0006). It asked two aggregates for them, `/api/posts/search/aggregate` and
`/api/comments/search/aggregate`. It asked `/api/users/interactions/subreddits` only when
one of those timed out. `interactions` answers posts and comments in one query
(`weight_posts=1000000` packs both into one count), but it was thought to be slower for
ordinary users.

The owner benchmarked it live on 2026-09-26 (`tools/lifetime_bench.mjs`). The sample was
50 commenters of an r/Hasan_Piker post, active users with a median of 170 subreddits each
and up to 1,032. Both were asked with the same bounds, in alternating order.
- **Agreement:** the counts agreed for all 50, subreddit for subreddit.
- **Latency:** `interactions` answered in a median of 1.35 s (p90 3.0 s). The two
  aggregates took 3.7 s (p90 6.3 s) together, and 2.3 s (p90 3.7 s) for the slower one alone.
- **Retries:** it drew no retries, where the aggregates drew 14.

## Decision

A full scan asks one `interactions` query per commenter for their lifetime counts
(`buildProfile`'s `interactionsFirst`, which `app.js` turns on). Only when it can't answer
do the two aggregates answer: when it refuses the user (a 4xx, as for huge accounts such as
AutoModerator) or times out. They're then split up as before when they time out too, and
`interactions` isn't asked again. A busy or rate-limiting server still fails the user rather
than being sent anything heavier (0002).

Scans limited (`only`) to subreddits the archive covers are unchanged (0005): their counts
come from the files, with one `interactions` query only for any gap before the post.

## Consequences

- **Fewer requests.** A commenter without saved counts costs about 3 requests instead of 4,
  and the heavy step is one query rather than two. A refused user costs one more (5).
- **Faster, lighter scans.** In the benchmark, `interactions` was the faster answer for 37
  of 50 users and drew fewer "slow down" replies.
- **Saved counts are unchanged in shape.** `interactions` may spell a subreddit in a
  different case, and `buildProfile` already merges names without regard to case. So no
  cache version bump is needed (0003).
- **Two orders in the code.** `core.js`'s default stays aggregates-first, which the older
  tests exercise; the page, the bench's `light-interactions` scenario and 0007's tests
  use the new order.
- **Revisit if** `interactions` starts disagreeing with the aggregates, refusing more
  accounts, or answering slower. `tools/lifetime_bench.mjs` measures all three.
