# Reddit Post Profiler (RPP)

Profile everyone who commented on a Reddit post, using the
[Arctic Shift](https://arctic-shift.photon-reddit.com/search) archive:

- how many posts/comments each commenter had made in the post's subreddit **before the
  post was created**. This shows whether they're a regular or a newcomer.
- **every subreddit** they're active in, with their post and comment counts in each.

## Use it in your browser

**https://tinted979.github.io/reddit-post-profiler/**

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

A thread with more than 300 commenters to profile asks first. It shows roughly how many
requests and how long profiling them all would take, and offers *Profile the top 300* (the
most active commenters), *Profile all* or *Cancel*. Setting *Only the N most active
commenters* (`max`) skips the question. Every request carries `meta-app=reddit-post-profiler`, as the
Arctic Shift site tags its own, so the archive's maintainer can see where the traffic comes from.

### Reading the results

| On a user's card | Meaning |
|---|---|
| *N in thread* | their comments in this thread (0 for a post author who didn't comment) |
| *new here* / *occasional* / *regular* | how established they were in the post's subreddit before the post was made (see [Badges](#badges)). The badge shows their posts and comments there; open the card for how many days they were active and when they started |
| *N subreddits* | subreddits they have archived posts or comments in |
| *saved* | reused from an earlier scan in this browser, with no new requests |
| *lookup failed* | Arctic Shift kept failing for this user (open the card for details). Press *Analyze* again to retry; saved results are reused for everyone else |

The line under a name lists the post's subreddit first, then their most active others.
Opening a card shows the full table, with the post's own subreddit highlighted at the top,
and a link to their Reddit profile.
Each post and comment count links to the Arctic Shift search page listing those posts or
comments (newest first, within the `years` window if set).

### Badges

A badge weighs three things about a user's activity in the post's subreddit before the
post: how many posts and comments, on how many **different days**, and how long before the
post the **first** one was. So a burst of comments in the week before the post still
reads *new here*, while the same number spread over months doesn't. The defaults:

| Badge | Posts + comments | Different days | First one at least |
|---|---|---|---|
| *regular* | 20+ | 8+ | 90 days before |
| *occasional* | 3+ | 2+ | 14 days before |
| *new here* | anyone else, including no activity at all | | |

Change them under *Options → Badges*; 0 turns a check off. They're remembered in this
browser, apply straight away to the results on screen and to saved scans (no new requests),
and a shared link carries them as `badges=` (six numbers: count, days and days-before for
occasional, then for regular, e.g. `badges=3,2,14,20,8,90`) without replacing the
recipient's own settings. For someone with more than 100 posts or more than 100 comments
there, the day count is taken from the newest 100 of each, so it's a lower bound. Scans
saved before badges looked at time only have counts, so their badges go by the count alone.

### Scheduler

To scan several posts without waiting on each, open *Scheduler*, paste post links (one per
line) and press *Add to queue*, then *Start queue*. They're scanned one after another, each
with the options that were set when it was added, and each lands in *Saved scans*. You can
use other tabs or windows meanwhile: the page paces its requests on a worker timer, which
browsers don't slow down in background tabs the way they do ordinary timers. The tab has to
stay open, but the queue is kept in this browser (localStorage), so after a reload or a
closed tab *Start queue* carries on where it was cut off. *Pause queue* stops after the
current scan; *Stop* ends the current scan and pauses the queue. Failed or stopped links
can be retried, and *Notify me when it's done* shows a browser notification at the end.
The queue runs in one tab at a time: in any other tab of the site it's shown read-only, and
that tab takes it over when the first one closes.

Because nobody is watching it, the queue goes easier on the API: it holds at most 25 scans
waiting at a time (links past that stay in the box to add later), profiles 2 users at a time
at most, and in a thread with more than 300 commenters profiles only the 300 most active,
unless *Only the N most active commenters* was set when the link was added.

### Saved scans

Every scan you run (or stop after some users are profiled) is listed under *Saved scans*,
newest first, with its post, how many users were profiled, how many are regular, occasional
or new to the subreddit, failures, the subreddits they're active in, and when it ran, how
many requests it made (to Arctic Shift and to the archive files) and how long it took. Click a post to see its users again exactly as
they were, with no requests; *Scan again* runs it again with the same options (reusing
saved results where it can), and *Delete* removes it. A new scan of a post replaces its
saved one, except that a stopped scan doesn't replace a complete one, and a scan where every
lookup failed isn't saved at all.

Under the list, the page shows how much of the browser's storage the site uses.
*Export to a file* downloads every saved scan as one JSON file, and *Import from a file*
adds the scans from such a file, for example on another device or browser. An imported
scan replaces the one saved here only if it's newer (and not a stopped copy of a complete
one), and every imported scan is checked;
its statistics are worked out again from its profiles. *Delete all saved scans* removes them
all after asking; unlike *Clear saved results*, it keeps the per-user results.

### Options and share links

*Copy link* builds a link that starts the same analysis as soon as it opens, and the
address bar shows one once you press *Analyze*. Options set by a link are listed next to
*Options*.

```
https://tinted979.github.io/reddit-post-profiler/?post=https://redd.it/1l7d1e4&max=20&op=1
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
| `delay` | seconds between request starts (default 0.75, minimum 0.25) |
| `par` | users profiled in parallel, 1–5 (default 2); also the most requests in flight at once |
| `cache` | days to keep and reuse saved results (default 7, `0` = don't save) |
| `badges` | badge thresholds, see [Badges](#badges) |

### Saved results and privacy

- The page has no server of its own and no analytics. Your browser sends every query
  straight to Arctic Shift, which sees the post and the usernames you look up.
- Results are saved in this browser's IndexedDB (database `reddit-tool`, the project's earlier name, kept so saved data carries over): each user's
  per-subreddit counts, and their "before" counts, days active and first date for each
  post you scan. They're reused
  for `cache` days; records older than that (and at least 30 days old) are deleted when
  the page loads. The scheduler's queue is kept in localStorage until you remove its links.
  Saved scans (each post, its options and every profile shown) are kept
  until you delete them. *Clear saved results* under *Options* deletes everything now, and
  `cache=0` saves nothing.
- A saved "before" count is reused only if it was fetched at least an hour after the post,
  and saved totals from before a user's latest comment in the thread aren't trusted to
  skip queries, so rescanning a thread that's still growing stays correct.

## Responsible use

Everything the tool shows is public Reddit activity archived by Arctic Shift, a free
service run by a volunteer. Use it to understand a discussion, such as whether a thread's
commenters are regulars in the subreddit, not to single out, harass or brigade people.
Go easy on the shared API: profile the most active commenters where that's enough. Anyone
can ask Arctic Shift to remove their data through its
[removal requests](https://github.com/ArthurHeitmann/arctic_shift#contact--removal-requests)
page; once it's removed there, this tool can't see it either. The page repeats this under
*About and responsible use*.

## Limits

- **Archived data only.** Counts include only what Arctic Shift has archived. New posts and
  comments usually appear within minutes; anything deleted before it was archived is
  missing. A post that isn't archived yet can't be analysed.
- **Deleted accounts.** Comments whose author shows as `[deleted]` or `[removed]` can't be
  traced to anyone, so they're skipped, and so is AutoModerator.
- **History window.** `years` counts back from today, not from the post, and applies
  to every count. For a post older than the window there's no "before" to count.
- **Very active users.** Their full history can time out; the fallbacks (see
  [How it works](#how-it-works)) take more requests, and if those fail the user shows
  *lookup failed*, with the reason in the CSV's `error` column.
- **Reddit app share links** (`reddit.com/r/<sub>/s/<code>`) don't contain the post id.
  Open the link and copy the full `…/comments/<id>/…` address instead.
- **Rate limits.** Arctic Shift is a free, shared service. A rate limit (HTTP 429) pauses
  every request, for 30 seconds; a "slow down" answer delays only the request
  that got it, and fewer requests run at once until the server recovers. If it keeps
  saying so, that user fails rather than piling on heavier queries. Please don't turn up
  the pace aggressively.

## CSV output

One row per (user, subreddit), sorted by the user's comment count in the thread, then by
activity in each subreddit:

```
username,thread_comments,target_subreddit,target_posts_before,target_comments_before,subreddit,posts,comments,total,error,target_active_days_before,target_first_before_utc,target_badge
barkmonster,2,learnpython,0,24,learnpython,0,82,82,,12,2024-03-05T18:22:10.000Z,occasional
barkmonster,2,learnpython,0,24,ADHD,0,53,53,,12,2024-03-05T18:22:10.000Z,occasional
…
```

- `thread_comments`: the user's comment count in the analysed thread
- `target_subreddit`: the post's subreddit
- `target_posts_before` / `target_comments_before`: their activity there before the post was created (blank if the lookup failed)
- `posts` / `comments` / `total`: their counts in `subreddit`, as archived by Arctic Shift: all-time, or since the start of the `years` window
- `error`: why the lookup failed, if it did
- `target_active_days_before`: different days they posted or commented in the post's subreddit before it (a lower bound past 100 posts or comments)
- `target_first_before_utc`: when the first of those was
- `target_badge`: `new`, `occasional` or `regular` under the badge settings in use (blank for a post older than the `years` window)

Subreddits below the minimum (`min`) are left out, except the post's own.
A user with no archived activity, or whose lookup failed, still gets one row. A CSV
downloaded mid-run is named `…_activity_partial.csv`.

## How it works

The page uses the [Arctic Shift API](https://github.com/ArthurHeitmann/arctic_shift/blob/master/api/README.md):

1. `GET /api/posts/ids` fetches the post's subreddit, author and creation time.
2. The commenters: the whole thread comes from
   `GET /api/comments/tree?link_id=…` in one request. `GET /api/comments/search?link_id=…`
   is paged by timestamp only if the tree is incomplete, fails, or the thread has 25,000+
   comments.
3. For each commenter, `GET /api/{posts,comments}/search/aggregate?aggregate=subreddit&author=…`
   returns per-subreddit counts. For the "before" facts it asks
   `GET /api/{posts,comments}/search?author=…&subreddit=…&before=<post time>&fields=created_utc&limit=100`
   for the timestamps themselves, which gives the count, the days active and the first
   date in one small request (the `created_utc` aggregate would be cheaper, but it
   currently answers all zeros). Past 100 items it adds the aggregate for the exact count
   and one more search for the first date. These run in parallel, and it skips a
   "before" query when the lifetime counts leave no room for one, e.g. when all of a
   user's comments in the subreddit are in this thread. For a subreddit with archive files on
   the project's R2 bucket, listed in the bucket's manifest
   (`https://rpp-db.tinted979.dev/manifest.json`), those come from the files instead, with
   Arctic Shift asked only about the days since the files were built. If you limit a scan
   to subreddits the archive covers (Only these subreddits), each user's counts there also
   come from the files, plus one request for anything newer.

Aggregations can time out for very active users. The page then tries
`GET /api/users/interactions/subreddits`, which answers for posts and comments in one query
(`weight_posts=1000000&weight_comments=1` packs both counts into one number). If that fails
too, it splits only the kind that timed out: into one query per subreddit when `subs` is
set, otherwise into yearly chunks. For ordinary users the two aggregations are quicker, so
they stay the first choice.

The page spaces request starts by `delay` and caps how many are in flight, starting at
`par`: the cap halves on a 429, slow-down or network error, and rises again after a run of
successes.

Archive file reads are byte-range requests to the R2 bucket, served through Cloudflare's
cache, so they aren't paced like Arctic Shift's. The status line counts both kinds while a
scan runs and when it ends ("… 120 Arctic Shift requests and 15 archive requests"), and
saved scans keep both counts.

## Development

```sh
cd web && npm test       # web app core (Node 22+, no dependencies)
```

To try the web app locally, serve `web/` with any static server (ES modules don't load
from `file://`), e.g. `python3 -m http.server -d web`, and open http://localhost:8000.

`.github/workflows/pages.yml` runs the tests on every push and pull request. On the
default branch (`main`) it then publishes the page files at the top of `web/` (`*.html`, `*.js`,
`*.css`) to GitHub Pages, failing if a module imports a file that isn't among them, and tags each script and stylesheet
with the commit so browsers don't mix cached versions; any
other kind of file the page needs must be added to its copy step. One-time setup: in the
repo's **Settings → Pages**, set *Source* to **GitHub Actions**. On a free GitHub plan,
Pages only works for public repositories.

Work happens on other branches and reaches `main` through pull requests, so the live site
only changes when a pull request is merged.

The archive files are built with `tools/build_dumps.py` and uploaded with
`tools/upload_dumps.sh`, which also checks the public URL serves them correctly (range
requests, CORS for the page's origin only, no compression). The bucket's Cloudflare
settings are listed in [CLAUDE.md](CLAUDE.md#subreddit-dumps-in-progress).

`.github/workflows/code-review.yml` has Claude review each pull request once when it's
opened, reopened or marked ready for review (drafts wait), and post its findings as inline
comments. It needs the Claude GitHub App installed on the repo and a
`CLAUDE_CODE_OAUTH_TOKEN` secret (from `claude setup-token`), so reviews use the Claude
subscription's usage rather than API billing. The review checks changes against the rules in
[CLAUDE.md](CLAUDE.md#rules-for-changes).

## License

[MIT](LICENSE).
