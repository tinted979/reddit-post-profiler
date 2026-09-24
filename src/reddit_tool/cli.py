"""Command-line entry point: `reddit-tool <post-url-or-id>`."""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime
from pathlib import Path

from .analyze import UserProfile, build_profile, collect_commenters, parse_post_ref
from .api import ArcticShiftClient, ArcticShiftError
from .output import write_csv


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="reddit-tool",
        description=(
            "Profile everyone who commented on a Reddit post: how active they were in "
            "the post's subreddit before it was posted, and how many posts/comments "
            "they have in every subreddit. Data comes from the Arctic Shift archive."
        ),
    )
    parser.add_argument("post", help="reddit post URL, redd.it link, t3_ fullname or post id")
    parser.add_argument(
        "-o", "--output", type=Path, help="CSV path (default: <post_id>_activity.csv)"
    )
    parser.add_argument(
        "--include-op", action="store_true", help="also profile the post's author"
    )
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        metavar="USER",
        help="username to skip; repeatable (AutoModerator and [deleted] are always skipped)",
    )
    parser.add_argument(
        "--max-users",
        type=int,
        metavar="N",
        help="only profile the N most active commenters in the thread",
    )
    parser.add_argument(
        "--min-count",
        type=int,
        default=0,
        metavar="N",
        help="omit subreddits where a user has fewer than N posts+comments "
        "(the target subreddit is always kept)",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=2.0,
        metavar="SECONDS",
        help="minimum pause between API requests (default: 2.0)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        post_id = parse_post_ref(args.post)
    except ValueError as exc:
        _log(f"error: {exc}")
        return 2
    output: Path = args.output or Path(f"{post_id}_activity.csv")

    with ArcticShiftClient(delay=args.delay) as client:
        try:
            post = client.get_post(post_id)
        except ArcticShiftError as exc:
            _log(f"error: couldn't fetch post {post_id}: {exc}")
            return 1
        if post is None:
            _log(f"error: post {post_id} is not in the Arctic Shift archive")
            return 1

        posted = datetime.fromtimestamp(post.created_utc, UTC).strftime("%Y-%m-%d %H:%M UTC")
        _log(f"r/{post.subreddit} · {post.title!r} by u/{post.author} ({posted})")

        try:
            commenters = collect_commenters(
                client, post, exclude=args.exclude, include_op=args.include_op
            )
        except ArcticShiftError as exc:
            _log(f"error: couldn't fetch comments: {exc}")
            return 1

        ranked = sorted(commenters.items(), key=lambda kv: (-kv[1], kv[0].lower()))
        if args.max_users is not None:
            ranked = ranked[: args.max_users]
        _log(
            f"{sum(commenters.values())} comments from {len(commenters)} users; "
            f"profiling {len(ranked)}"
        )

        profiles: list[UserProfile] = []
        interrupted = False
        try:
            for i, (username, n) in enumerate(ranked, 1):
                _log(f"[{i}/{len(ranked)}] u/{username}")
                try:
                    profiles.append(build_profile(client, username, n, post))
                except ArcticShiftError as exc:
                    _log(f"  failed: {exc}")
                    profiles.append(
                        UserProfile(username=username, thread_comments=n, error=str(exc))
                    )
        except KeyboardInterrupt:
            interrupted = True
            _log("interrupted; writing the profiles collected so far")

    rows = write_csv(profiles, post, output, min_count=args.min_count)
    errors = sum(1 for p in profiles if p.error)
    _log(
        f"wrote {rows} rows for {len(profiles)} users to {output}"
        + (f" ({errors} failed)" if errors else "")
    )
    return 130 if interrupted else 0


if __name__ == "__main__":
    raise SystemExit(main())
