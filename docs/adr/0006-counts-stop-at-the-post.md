# 0006. Every count stops at the post

**Status:** Accepted (recorded 2026-09-26). Partly supersedes 0005: a covered subreddit's tail now stops at the post, and a covered post's thread comes from the files plus one search (post older than the files) or the comment tree (newer), not from the tail.

## Context

A scan reports, for everyone who commented on a post, their activity in the post's subreddit before the post, and their per-subreddit activity everywhere. The first always stopped at the post. The second counted up to when the scan ran, so it included what commenters did after the post, which says nothing about who they were when they showed up. The owner confirmed that up-to-now counts were never intended.

It also cost requests. For a covered subreddit, an "only" scan's counts needed the archive's tail to reach the present. A day-old build meant 35–40 pages, or one request per commenter.

## Decision

Every count a scan shows stops at the post's creation time:

- the per-subreddit counts: aggregates and `interactions` with `before=<post time>`, and archive rows before it;
- the "before" facts, as before;
- the history window (`years`), counted back from the post rather than from today;
- the links from counts to Arctic Shift.

A covered subreddit's tail goes only up to the post. A post older than where the files end needs no tail at all.

The thread's own comments are the one thing asked about past the post: they come after it by definition, and they're needed to know who commented. Arctic Shift is asked only for the part the archive lacks. For a post older than the files, that's `comments_by_link` up to the files' cutoff, plus a search for the thread's comments after it. For a newer post, it's the comment tree.

## Consequences

- **Fewer requests with the archive.** A covered post older than the files costs about 2 requests for an "only" scan, whatever its size. A newer one needs its tail only up to the post.
- **Saved counts are per post.** The cache version is bumped (0003). A queue of posts sharing commenters no longer reuses one commenter's totals across posts.
- **Old saved scans.** Scans saved before this counted up to when they ran. They're marked as such when opened (no `countsTo`), and their links stay unbounded.
- **Revisit if** there's a need for "what they did afterwards". That would be a separate, explicitly labelled view, not a change to these counts.
