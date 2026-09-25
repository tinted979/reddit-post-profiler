# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Check a dumps/ build against what's live on R2 before uploading it.

upload_dumps.sh runs this first, because the manifest it uploads replaces the live one
whole and build files are never replaced:

- a live subreddit missing from the local manifest would be dropped (a fresh or partial
  dumps/ directory), sending its scans back to the API;
- a new build whose r/<subreddit>/<version>/ already exists on R2 would publish a
  manifest whose byte sizes don't match the files served, breaking every read;
- the live version rebuilt locally with different files has the same problem;
- a manifest format change needs the page to understand it first.

Usage: check_upload.py LOCAL_MANIFEST LIVE_MANIFEST BUILDS [--drop KEY ...] [--allow-format-change]

LIVE_MANIFEST is the live manifest.json (an empty file if there is none yet), and BUILDS
the output of `rclone lsf -R --dirs-only --max-depth 2 <remote>:<bucket>/r`.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def parse_builds(listing: str) -> set[str]:
    """ "key/version" for each build directory in an rclone lsf listing of r/."""
    builds = set()
    for line in listing.splitlines():
        parts = line.strip().strip("/").split("/")
        if len(parts) == 2 and all(parts):
            builds.add("/".join(parts))
    return builds


def problems(local: dict, live: dict | None, builds: set[str], allow_drop: set[str] = frozenset(),
             allow_format_change: bool = False) -> list[str]:
    """Why uploading `local` over `live` would break the archive; empty if it's safe."""
    found = []
    if live is None:
        return found
    if live.get("format") != local.get("format") and not allow_format_change:
        found.append(f"the live manifest has format {live.get('format')} and this one {local.get('format')}: "
                     "deploy a page that reads the new format first, then pass --allow-format-change")
    local_subs = local.get("subreddits", {})
    live_subs = live.get("subreddits", {})
    for key, sub in live_subs.items():
        if key not in local_subs and key not in allow_drop:
            found.append(f"r/{sub.get('name', key)} is live but not in this manifest, so uploading would drop it: "
                         "build it into this directory too (or start from the live manifest.json), "
                         f"or pass --drop {key} to remove it on purpose")
    for key, sub in local_subs.items():
        version = sub.get("version")
        was = live_subs.get(key)
        if was and was.get("version") == version:
            if files(was) != files(sub):
                found.append(f"r/{key}/{version}/ is live with different files than this build: builds are never "
                             "overwritten, so rebuild with a new --version")
        elif f"{key}/{version}" in builds:
            found.append(f"r/{key}/{version}/ already exists on R2, and its files wouldn't be replaced: "
                         "rebuild with a new --version")
    return found


def files(sub: dict) -> dict:
    return {name: (f.get("path"), f.get("bytes")) for name, f in sub.get("files", {}).items()}


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("local", type=Path, help="the manifest.json about to be uploaded")
    parser.add_argument("live", type=Path, help="the live manifest.json (empty file: none yet)")
    parser.add_argument("builds", type=Path, help="rclone lsf -R --dirs-only --max-depth 2 listing of r/")
    parser.add_argument("--drop", action="append", default=[], help="a subreddit key to remove on purpose")
    parser.add_argument("--allow-format-change", action="store_true")
    args = parser.parse_args(argv)
    local = json.loads(args.local.read_text(encoding="utf-8"))
    text = args.live.read_text(encoding="utf-8").strip()
    live = json.loads(text) if text else None
    builds = parse_builds(args.builds.read_text(encoding="utf-8"))
    found = problems(local, live, builds, set(args.drop), args.allow_format_change)
    for problem in found:
        print(f"error: {problem}", file=sys.stderr)
    if found:
        sys.exit(1)


if __name__ == "__main__":
    main()
