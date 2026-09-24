"""CSV output: one row per (user, subreddit)."""

from __future__ import annotations

import csv
from collections.abc import Iterable
from pathlib import Path

from .analyze import UserProfile
from .api import Post

COLUMNS = [
    "username",
    "thread_comments",
    "target_subreddit",
    "target_posts_before",
    "target_comments_before",
    "subreddit",
    "posts",
    "comments",
    "total",
    "error",
]


def write_csv(
    profiles: Iterable[UserProfile], post: Post, path: Path, *, min_count: int = 0
) -> int:
    """Write profiles to `path`; returns the number of data rows written.

    Subreddits with fewer than `min_count` posts+comments are dropped, except the
    target subreddit. Every user gets at least one row so nobody silently disappears.
    """
    target = post.subreddit.lower()
    rows = 0
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS)
        writer.writeheader()
        for p in profiles:
            base = {
                "username": p.username,
                "thread_comments": p.thread_comments,
                "target_subreddit": post.subreddit,
                "target_posts_before": "" if p.error else p.target_posts_before,
                "target_comments_before": "" if p.error else p.target_comments_before,
                "error": p.error or "",
            }
            subs = sorted(
                (
                    (name, c)
                    for name, c in p.subreddits.items()
                    if c.total >= min_count or name.lower() == target
                ),
                key=lambda item: (-item[1].total, item[0].lower()),
            )
            if not subs:
                writer.writerow(base)
                rows += 1
            for name, c in subs:
                writer.writerow(
                    base
                    | {
                        "subreddit": name,
                        "posts": c.posts,
                        "comments": c.comments,
                        "total": c.total,
                    }
                )
                rows += 1
    return rows
