---
paths:
  - "web/core.js"
  - "web/dumps.js"
  - "web/bench/**"
  - "tools/**"
---
# Arctic Shift API facts (verified live)

- The rate-limit header `x-ratelimit-reset` isn't exposed to browsers because there's no CORS expose header, so the web app waits 30 s on a 429.
- A 422 "Timeout. Maybe slow down a bit" is the server-busy reply and is retried. It is not a client error.
- Throughput tops out at about 0.8 requests/s (about 10 users/min for a fresh scan) whatever the settings: with 2 or more users in parallel a request takes about 1.3 s, and 3–5 in parallel only bring more "slow down" replies (benchmarked Sept 2026 over a delay 0.25–1 s × parallel 1–5 grid). That's why the defaults are 0.75 s and 2 in parallel. The rate limit resets on 60 s boundaries (`x-ratelimit-reset-at` steps by 60000 ms, and `x-ratelimit-reset` stays at or under 60) and appears to be per IP: a sandbox sharing its IP got 429s while idle.
- `/api/comments/tree` accepts `limit` up to 25000 and does not support `fields`.
- `aggregate=created_utc&frequency=…` answers all-zero counts (even with only a subreddit filter), so it can't give a timeline; search with `fields=created_utc` can.
- `interactions` has no `subreddit` parameter. It returns 400 "not supported" for huge accounts such as AutoModerator.
- `/api/users/interactions/subreddits`'s `after` is exclusive, like search's (an item at exactly `after` isn't counted).
- The search website (`/search?fun=posts_search|comments_search&author=&subreddit=&after=`) is a front end over the same API, so scraping it saves nothing.
- Subreddit-wide search (no `author` or `link_id`) works for a whole subreddit's recent activity (checked 2026-09-25: 10 requests, 3 s apart, no 422 or 429).
  - **Request shape:** `/api/{posts,comments}/search?subreddit=&after=&sort=asc&limit=auto&fields=…`.
  - **Speed:** it answers in 0.3–1.4 s, even for r/AskReddit (~200k comments/day) and for a window starting 7 days back.
  - **Names:** the subreddit name is case-insensitive.
  - **Fields:** `fields=id,author,created_utc,link_id` (comments) and `fields=id,author,created_utc` (posts) return just those keys.
  - **Order:** rows are ascending by `created_utc`, and `after` is exclusive.
  - **Paging:** `after=<last created_utc> − 1` repeats the boundary second without skipping anything.
- `limit=auto` returned 100 rows, the same as `limit=100` (checked 2026-09-25). So paging costs about one request per 100 items; r/Hasan_Piker's ~1,900 comments a day are ~20 pages.
- Outside a browser, responses carry `x-ratelimit-reset` (seconds left in the current 60 s window) and `x-ratelimit-reset-at` (epoch ms, on a minute boundary), but no `x-ratelimit-remaining` (checked 2026-09-25).

Add a fact here only after checking it live, with the date. Agents may only use endpoints and
parameters listed here; anything else needs a live check by a human first (docs/adr/0002).
