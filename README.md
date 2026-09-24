# reddit-tool

Profile everyone who commented on a Reddit post, using the
[Arctic Shift](https://arctic-shift.photon-reddit.com/search) archive:

- how many posts/comments each commenter had made in the post's subreddit **before the
  post was created**. This shows whether they're a regular or a newcomer.
- **every subreddit** they're active in, with their post and comment counts in each.

## Use it in your browser

**https://tinted979.github.io/reddit-tool/**

Nothing to install. Paste a post URL and press *Analyze*. Results appear as each user is
profiled; click a user to see every subreddit they're active in, or download the same CSV
as the command-line version. Everything runs in the visitor's browser and talks to Arctic
Shift directly, so there's no server to maintain.

The web version profiles several users at once and skips the "before this post" lookups
when a user's lifetime counts show there can't be any, so most commenters cost 2 requests
instead of 4. It fetches a thread's whole comment tree in one request, and saves results in
your browser (IndexedDB): rescanning a thread, or scanning another one with the same people,
reuses them for 7 days by default instead of asking the API again. *Clear saved results*
in the options empties the store. If Arctic Shift rate-limits or asks to slow down, all
requests pause and the pace eases off automatically.

You can share a link that starts an analysis as soon as it opens (*Copy link* builds one
with the current options):

```
https://tinted979.github.io/reddit-tool/?post=https://redd.it/1l7d1e4&max=20&op=1
```

| Parameter | Meaning |
|---|---|
| `post` | post URL or id (starts the analysis automatically) |
| `max` | only profile the top N commenters |
| `op=1` | also profile the post's author |
| `exclude` | comma-separated usernames to skip |
| `subs` | comma-separated subreddits to limit results to (the post's subreddit is always included) |
| `years` | only count activity from the last 1, 5 or 10 years (default: all time) |
| `min` | hide subreddits with fewer than N posts+comments |
| `delay` | seconds between request starts (default 0.5) |
| `par` | users profiled in parallel, 1–5 (default 3) |
| `cache` | days to reuse saved results (default 7, `0` = off) |

The site lives in `web/`. `.github/workflows/pages.yml` runs both test suites on every
push and deploys `web/` to GitHub Pages from the default branch. One-time setup: in the
repo's **Settings → Pages**, set *Source* to **GitHub Actions**. On a free GitHub plan,
Pages only works for public repositories.

## Command-line version

### Install / run

Requires [uv](https://docs.astral.sh/uv/).

```sh
uv sync
uv run reddit-tool https://www.reddit.com/r/learnpython/comments/1l7d1e4/running_python_scripts/
```

The post can be given as a full reddit URL, a `redd.it/<id>` link, a `t3_<id>` fullname or
the bare post id.

#### Options

| Option | Meaning |
|---|---|
| `-o, --output PATH` | CSV path (default `<post_id>_activity.csv`) |
| `--include-op` | also profile the post's author |
| `--exclude USER` | username to skip, repeatable (`AutoModerator` and `[deleted]` are always skipped) |
| `--max-users N` | only profile the N most active commenters in the thread |
| `--min-count N` | omit subreddits where a user has fewer than N posts+comments (the target subreddit is always kept) |
| `--delay SECONDS` | minimum pause between API requests (default 2.0) |

Each commenter costs 4 API requests, so a thread with 100 commenters takes roughly 15
minutes at the default delay. Arctic Shift is a free service, so please don't lower the
delay aggressively. Press Ctrl-C to stop early; the profiles collected so far are still
written.

### Output

One CSV row per (user, subreddit), sorted by the user's comment count in the thread, then
by activity in each subreddit:

```
username,thread_comments,target_subreddit,target_posts_before,target_comments_before,subreddit,posts,comments,total,error
barkmonster,2,learnpython,0,24,learnpython,0,82,82,
barkmonster,2,learnpython,0,24,ADHD,0,53,53,
…
```

- `thread_comments`: the user's comment count in the analysed thread
- `target_posts_before` / `target_comments_before`: their activity in the post's subreddit before the post was created
- `posts` / `comments` / `total`: all-time counts in `subreddit`, as archived by Arctic Shift

A user with no archived activity, or whose lookup failed (see `error`), still gets one row.

## How it works

1. `GET /api/posts/ids` fetches the post's subreddit and creation time.
2. `GET /api/comments/search?link_id=…` is paged by timestamp to collect the commenters.
3. For each commenter, `GET /api/{posts,comments}/search/aggregate?aggregate=subreddit&author=…`
   returns per-subreddit counts. The same call with `subreddit=…&before=<post time>`
   returns the "before" counts.

Rate limits (HTTP 429) and the server's "slow down" responses are retried with backoff.
Aggregations that time out for very active users are split into yearly chunks and summed.

The web version differs in a few places:

- Commenters come from `GET /api/comments/tree?link_id=…` in one request. If the tree is
  incomplete or fails, it falls back to paging the search with `limit=auto`.
- When a very active user's aggregations time out, it first tries
  `GET /api/users/interactions/subreddits`. This endpoint answers with posts and comments
  combined in one query (`weight_posts=1000000&weight_comments=1` packs both counts into
  one number). Only if that fails too does it split the aggregations into yearly chunks.
  For ordinary users the two aggregations are quicker, so they stay the first choice.

## Development

```sh
uv run pytest            # Python CLI
cd web && npm test       # web app core (Node 22+, no dependencies)
```

To try the web app locally, serve `web/` with any static server, e.g.
`python3 -m http.server -d web`, and open http://localhost:8000.
