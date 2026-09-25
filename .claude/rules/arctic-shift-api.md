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

Add a fact here only after checking it live, with the date. Agents may only use endpoints and
parameters listed here; anything else needs a live check by a human first (docs/adr/0002).
