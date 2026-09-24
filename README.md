# reddit-tool

Profile everyone who commented on a Reddit post, using the
[Arctic Shift](https://arctic-shift.photon-reddit.com/search) archive:

- how many posts/comments each commenter had made in the post's subreddit **before the
  post was created**. This shows whether they're a regular or a newcomer.
- **every subreddit** they're active in, with their post and comment counts in each.

## Install / run

Requires [uv](https://docs.astral.sh/uv/).

```sh
uv sync
uv run reddit-tool https://www.reddit.com/r/learnpython/comments/1l7d1e4/running_python_scripts/
```

The post can be given as a full reddit URL, a `redd.it/<id>` link, a `t3_<id>` fullname or
the bare post id.

### Options

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

## Output

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

## Development

```sh
uv run pytest
```
