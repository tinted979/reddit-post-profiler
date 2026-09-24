"""Find the commenters of a post and build per-user subreddit activity profiles."""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field

from .api import ArcticShiftClient, Post

# Accounts that are never interesting to profile.
DEFAULT_EXCLUDED = frozenset({"[deleted]", "[removed]", "automoderator"})

_ID = r"[0-9a-z]{1,13}"
_URL_PATTERNS = (
    re.compile(rf"/comments/({_ID})(?:[/?#]|$)", re.IGNORECASE),
    re.compile(rf"redd\.it/({_ID})(?:[/?#]|$)", re.IGNORECASE),
)
_BARE_ID = re.compile(rf"^(?:t3_)?({_ID})$", re.IGNORECASE)


def parse_post_ref(ref: str) -> str:
    """Extract the base-36 post id from a reddit URL, redd.it link, `t3_` fullname or id."""
    ref = ref.strip()
    for pattern in _URL_PATTERNS:
        if m := pattern.search(ref):
            return m.group(1).lower()
    if m := _BARE_ID.match(ref):
        return m.group(1).lower()
    raise ValueError(
        f"can't find a post id in {ref!r}; pass a reddit post URL "
        "(…/comments/<id>/…), a redd.it link, or the post id"
    )


@dataclass
class SubCounts:
    posts: int = 0
    comments: int = 0

    @property
    def total(self) -> int:
        return self.posts + self.comments


@dataclass
class UserProfile:
    username: str
    thread_comments: int
    target_posts_before: int = 0
    target_comments_before: int = 0
    subreddits: dict[str, SubCounts] = field(default_factory=dict)
    error: str | None = None


def collect_commenters(
    client: ArcticShiftClient,
    post: Post,
    *,
    exclude: Iterable[str] = (),
    include_op: bool = False,
) -> Counter[str]:
    """Map each commenter on `post` to how many comments they left in the thread."""
    excluded = DEFAULT_EXCLUDED | {name.lower().removeprefix("u/") for name in exclude}
    counts: Counter[str] = Counter()
    for comment in client.iter_thread_comments(post.id):
        author = comment.get("author")
        if author and author.lower() not in excluded:
            counts[author] += 1
    if include_op and post.author.lower() not in excluded:
        # Make sure the OP is profiled even if they never commented.
        counts[post.author] += 0
    return counts


def build_profile(
    client: ArcticShiftClient, username: str, thread_comments: int, post: Post
) -> UserProfile:
    profile = UserProfile(username=username, thread_comments=thread_comments)

    by_key: dict[str, SubCounts] = {}
    for kind in ("posts", "comments"):
        for sub, n in client.subreddit_counts(kind, username).items():
            # Merge case-insensitively, keeping the first spelling we saw.
            counts = by_key.get(sub.lower())
            if counts is None:
                counts = by_key[sub.lower()] = profile.subreddits[sub] = SubCounts()
            setattr(counts, kind, getattr(counts, kind) + n)

    before = {"subreddit": post.subreddit, "before": post.created_utc}
    profile.target_posts_before = sum(
        client.subreddit_counts("posts", username, **before).values()
    )
    profile.target_comments_before = sum(
        client.subreddit_counts("comments", username, **before).values()
    )
    return profile
