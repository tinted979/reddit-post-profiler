# reddit-tool

Profile everyone who commented on a Reddit post, using the
[Arctic Shift](https://arctic-shift.photon-reddit.com/search) archive:

- how many posts/comments each commenter had made in the post's subreddit **before the
  post was created**. This shows whether they're a regular or a newcomer.
- **every subreddit** they're active in, with their post and comment counts in each.

There's a web version and a command-line version; both write the same CSV.

## Use it in your browser

**https://tinted979.github.io/reddit-tool/**

Nothing to install. Paste a post URL and press *Analyze*. Users appear as they're
profiled, ordered by how many comments they left in the thread. Click a user to see every
subreddit they're active in, filter by user or subreddit, or download a CSV. The status line
estimates the time left from the recent pace, allowing for saved results and any rate-limit
pause, and when the run ends it shows how long it really took (and how much of that was
profiling, the part the estimate covers). *Stop* ends a run at once and keeps what was found so far.

Everything runs in your browser and talks to Arctic Shift directly. The whole thread comes
in one request, several users are profiled at once, and most commenters take 2 requests.
Results are saved in your browser, so rescanning a thread, or scanning another one with
some of the same people, reuses them instead of asking the API again.

### Reading the results

| On a user's card | Meaning |
|---|---|
| *N in thread* | their comments in this thread (0 for a post author who didn't comment) |
| *new here* / *occasional* / *regular* | their posts + comments in the post's subreddit before the post was made: none / 1–9 / 10 or more. The badge shows the counts |
| *N subreddits* | subreddits they have archived posts or comments in |
| *saved* | reused from an earlier scan in this browser, with no new requests |
| *lookup failed* | Arctic Shift kept failing for this user (open the card for details). Press *Analyze* again to retry; saved results are reused for everyone else |

The line under a name lists the post's subreddit first, then their most active others.
Opening a card shows the full table, with the post's own subreddit highlighted at the top,
and a link to their Reddit profile.
Each post and comment count links to the Arctic Shift search page listing those posts or
comments (newest first, within the `years` window if set).

### Saved scans

Every scan you run (or stop after some users are profiled) is listed under *Saved scans*,
newest first, with its post, how many users were profiled, how many are regular, occasional
or new to the subreddit, failures, the subreddits they're active in, and when it ran, how
many requests it made and how long it took. Click a post to see its users again exactly as
they were, with no requests; *Scan again* runs it again with the same options (reusing
saved results where it can), and *Delete* removes it. A new scan of a post replaces its
saved one.

### Options and share links

*Copy link* builds a link that starts the same analysis as soon as it opens, and the
address bar shows one once you press *Analyze*. Options set by a link are listed next to
*Options*.

```
https://tinted979.github.io/reddit-tool/?post=https://redd.it/1l7d1e4&max=20&op=1
```

| Parameter | Meaning |
|---|---|
| `post` | post URL or id (starts the analysis automatically) |
| `max` | only profile the N most active commenters in the thread |
| `op=1` | also profile the post's author |
| `exclude` | comma-separated usernames to skip |
| `subs` | comma-separated subreddits to limit results to; the post's subreddit is always included, and listed ones are shown even with no activity. For very active users it also means far fewer requests |
| `years` | only count activity from the last 1, 5 or 10 years, counted back from today (default: all time) |
| `min` | hide subreddits with fewer than N posts + comments, on the page and in the CSV (the post's subreddit is always kept) |
| `delay` | seconds between request starts (default 0.5, minimum 0.25) |
| `par` | users profiled in parallel, 1–5 (default 3); also the most requests in flight at once |
| `cache` | days to keep and reuse saved results (default 7, `0` = don't save) |

### Saved results and privacy

- The page has no server of its own and no analytics. Your browser sends every query
  straight to Arctic Shift, which sees the post and the usernames you look up.
- Results are saved in this browser's IndexedDB (database `reddit-tool`): each user's
  per-subreddit counts, and their "before" counts for each post you scan. They're reused
  for `cache` days; records older than that (and at least 30 days old) are deleted when
  the page loads. Saved scans (each post, its options and every profile shown) are kept
  until you delete them. *Clear saved results* under *Options* deletes everything now, and
  `cache=0` saves nothing.
- A saved "before" count is reused only if it was fetched at least an hour after the post,
  and saved totals from before a user's latest comment in the thread aren't trusted to
  skip queries, so rescanning a thread that's still growing stays correct.

## Limits

- **Archived data only.** Counts include only what Arctic Shift has archived. New posts and
  comments usually appear within minutes; anything deleted before it was archived is
  missing. A post that isn't archived yet can't be analysed.
- **Deleted accounts.** Comments whose author shows as `[deleted]` or `[removed]` can't be
  traced to anyone, so they're skipped, and so is AutoModerator.
- **History window (web).** `years` counts back from today, not from the post, and applies
  to every count. For a post older than the window there's no "before" to count.
- **Very active users.** Their full history can time out; the fallbacks (see
  [How it works](#how-it-works)) take more requests, and if those fail the user shows
  *lookup failed*, with the reason in the CSV's `error` column.
- **Reddit app share links** (`reddit.com/r/<sub>/s/<code>`) don't contain the post id.
  Open the link and copy the full `…/comments/<id>/…` address instead.
- **Rate limits.** Arctic Shift is a free, shared service. A rate limit (HTTP 429) pauses
  every request, for 30 seconds in the web app; a "slow down" answer delays only the request
  that got it, and fewer requests run at once until the server recovers. If it keeps
  saying so, that user fails rather than piling on heavier queries. Please don't turn up
  the pace aggressively.

## Command-line version

Requires [uv](https://docs.astral.sh/uv/) (Python 3.12+, which uv installs if needed).

```sh
uv sync
uv run reddit-tool https://www.reddit.com/r/learnpython/comments/1l7d1e4/running_python_scripts/
```

The post can be given as a full reddit URL, a `redd.it/<id>` link, a `t3_<id>` fullname or
the bare post id. Progress is printed to stderr; the results go to a CSV file.

| Option | Meaning |
|---|---|
| `-o, --output PATH` | CSV path (default `<post_id>_activity.csv`) |
| `--include-op` | also profile the post's author |
| `--exclude USER` | username to skip, repeatable (`AutoModerator`, `[deleted]` and `[removed]` are always skipped) |
| `--max-users N` | only profile the N most active commenters in the thread |
| `--min-count N` | omit subreddits where a user has fewer than N posts+comments (the target subreddit is always kept) |
| `--delay SECONDS` | minimum pause between API requests (default 2.0) |

The CLI profiles one user at a time with 4 requests each and saves nothing between runs,
so a thread with 100 commenters takes roughly 15 minutes at the default delay. It has no
equivalent of the web app's `subs` or `years`. Press Ctrl-C to stop early; the profiles
collected so far are still written.

## CSV output

One row per (user, subreddit), sorted by the user's comment count in the thread, then by
activity in each subreddit:

```
username,thread_comments,target_subreddit,target_posts_before,target_comments_before,subreddit,posts,comments,total,error
barkmonster,2,learnpython,0,24,learnpython,0,82,82,
barkmonster,2,learnpython,0,24,ADHD,0,53,53,
…
```

- `thread_comments`: the user's comment count in the analysed thread
- `target_subreddit`: the post's subreddit
- `target_posts_before` / `target_comments_before`: their activity there before the post was created (blank if the lookup failed)
- `posts` / `comments` / `total`: their counts in `subreddit`, as archived by Arctic Shift: all-time, or since the start of the web app's `years` window
- `error`: why the lookup failed, if it did

Subreddits below the minimum (`--min-count` or `min`) are left out, except the post's own.
A user with no archived activity, or whose lookup failed, still gets one row. A CSV
downloaded mid-run is named `…_activity_partial.csv`.

## How it works

Both versions use the [Arctic Shift API](https://github.com/ArthurHeitmann/arctic_shift/blob/master/api/README.md):

1. `GET /api/posts/ids` fetches the post's subreddit, author and creation time.
2. The commenters: the web app gets the whole thread from
   `GET /api/comments/tree?link_id=…` in one request, and pages
   `GET /api/comments/search?link_id=…` by timestamp only if the tree is incomplete, fails,
   or the thread has 25,000+ comments. The CLI always pages the search.
3. For each commenter, `GET /api/{posts,comments}/search/aggregate?aggregate=subreddit&author=…`
   returns per-subreddit counts. The same call with `subreddit=…&before=<post time>`
   returns the "before" counts. The web app runs these in parallel and skips a "before"
   query when the lifetime counts leave no room for one, e.g. when all of a user's
   comments in the subreddit are in this thread.

Aggregations can time out for very active users; both versions retry once. The CLI then
splits the query into yearly chunks and adds them up. The web app first tries
`GET /api/users/interactions/subreddits`, which answers for posts and comments in one query
(`weight_posts=1000000&weight_comments=1` packs both counts into one number). If that fails
too, it splits only the kind that timed out: into one query per subreddit when `subs` is
set, otherwise into yearly chunks. For ordinary users the two aggregations are quicker, so
they stay the first choice.

The web app spaces request starts by `delay` and caps how many are in flight, starting at
`par`: the cap halves on a 429, slow-down or network error, and rises again after a run of
successes.

## Development

```sh
uv run pytest            # Python CLI
cd web && npm test       # web app core (Node 22+, no dependencies)
```

To try the web app locally, serve `web/` with any static server (ES modules don't load
from `file://`), e.g. `python3 -m http.server -d web`, and open http://localhost:8000.

`.github/workflows/pages.yml` runs both test suites on every push and pull request. On the
default branch it then publishes the page files at the top of `web/` (`*.html`, `*.js`,
`*.css`) to GitHub Pages, failing if a module imports a file that isn't among them, and tags each script and stylesheet
with the commit so browsers don't mix cached versions; any
other kind of file the page needs must be added to its copy step. One-time setup: in the
repo's **Settings → Pages**, set *Source* to **GitHub Actions**. On a free GitHub plan,
Pages only works for public repositories.
