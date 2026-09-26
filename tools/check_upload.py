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

To publish one subreddit's build rather than a whole manifest (the archive sync, and
upload_dumps.sh --only; docs/adr/0005), with no token:

  check_upload.py merge-one --key KEY --dumps DIR --live LIVE_MANIFEST --log LOG --out BUNDLE [--allow-older]

It merges r/KEY's entry from DIR/manifest.json into the live manifest (as downloaded,
byte for byte), leaving every other entry as it's live, and checks the new build: a
version that isn't live or already published, its three files in DIR with the sizes its
entry gives, and cutoffs that aren't in the future or earlier than the live ones (unless
--allow-older). LOG is the live r/KEY/published.json, or a missing or empty file if there's
none yet. BUNDLE, a new directory, gets what tools/publish_build.sh uploads: key, version,
live.sha256 (the live manifest's, so it can tell if another publish came between),
manifest.json, r/KEY/<version>/*.parquet and r/KEY/published.json (the log with this
publish added), and `prune` when older builds are due to go: r/KEY's builds that the log says
were replaced at least PRUNE_AFTER ago, never the live one or the new one, at most PRUNE_MAX
a publish, oldest first. They're recorded in the log's `pruned`, so none is listed twice.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import time
from pathlib import Path

# A subreddit's key in the manifest (its name, lowercase), and a build's version: as
# build_dumps.py writes them, and as tools/publish_build.sh checks them.
KEY_NAME = re.compile(r"^[a-z0-9_]{2,21}$")
VERSION_NAME = re.compile(r"^\w[\w.-]{0,39}$", re.ASCII)
# The files of a build.
BUILD_FILES = ("posts_by_author", "comments_by_author", "comments_by_link")
# r/<key>/published.json: {format, subreddit, publishes: [{version, replaced, utc}], pruned:
# [version]}, one publish entry per publish, oldest first (`pruned` only once there are any).
# A replaced build is deleted PRUNE_AFTER after the publish that replaced it, long after any
# page could still hold a manifest naming it (they're cached 5 minutes), so the log keeps its
# newest LOG_KEEP entries (six weeks of hourly ones).
LOG_FORMAT = 1
LOG_KEEP = 1000
PRUNE_AFTER = 72 * 3600
PRUNE_MAX = 5


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


def is_time(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def log_problem(log, key: str) -> str | None:
    """Why a downloaded publish log can't be added to, or None."""
    if not isinstance(log, dict) or log.get("format") != LOG_FORMAT or log.get("subreddit") != key:
        return "isn't a publish log for this subreddit"
    entries = log.get("publishes")
    if not isinstance(entries, list):
        return "has no list of publishes"
    for e in entries:
        ok = (isinstance(e, dict) and isinstance(e.get("version"), str) and VERSION_NAME.match(e["version"])
              and is_time(e.get("utc"))
              and (e.get("replaced") is None or (isinstance(e["replaced"], str) and VERSION_NAME.match(e["replaced"]))))
        if not ok:
            return f"has an entry that doesn't check out: {e!r}"
    pruned = log.get("pruned", [])
    if not isinstance(pruned, list) or not all(isinstance(v, str) and VERSION_NAME.match(v) for v in pruned):
        return "has a list of pruned builds that doesn't check out"
    return None


def due_for_pruning(log: dict | None, keep: set, now: int) -> list[str]:
    """r/<key>'s builds that `log` says were replaced at least PRUNE_AFTER before `now`, not
    pruned yet and not in `keep`: at most PRUNE_MAX, oldest first."""
    if log is None:
        return []
    done = set(log.get("pruned", []))
    due = []
    for e in log["publishes"]:
        v = e.get("replaced")
        if v and e["utc"] <= now - PRUNE_AFTER and v not in done and v not in keep and v not in due:
            due.append(v)
    return due[:PRUNE_MAX]


def newly_pruned(old_log: dict | None, new_log: dict) -> list[str]:
    """The builds `new_log` records as pruned that `old_log` didn't: the bundle's prune list."""
    before = set(old_log.get("pruned", [])) if isinstance(old_log, dict) else set()
    return [v for v in new_log.get("pruned", []) if v not in before]


def merge_one(local: dict, live: dict | None, key: str, sizes: dict[str, int], log, now: int,
              allow_older: bool = False) -> tuple[dict | None, dict | None, list[str]]:
    """Merge r/<key>'s entry from `local` into `live`. `sizes` maps each file path found in the
    local build to its size, and `log` is the live publish log (None if there's none).
    Returns (the merged manifest, the log with this publish added, problems); the first two
    are None when there are problems."""
    found = []
    if live is None:
        return None, None, ["there's no live manifest to merge into: publish the first one with upload_dumps.sh"]
    if local.get("format") != live.get("format"):
        found.append(f"the local manifest has format {local.get('format')} and the live one {live.get('format')}: "
                     "a format change goes up whole, with upload_dumps.sh --allow-format-change")
    if not KEY_NAME.match(key):
        return None, None, found + [f"{key!r} is not a subreddit key (its name, lowercase)"]
    entry = (local.get("subreddits") or {}).get(key)
    if not isinstance(entry, dict):
        return None, None, found + [f"r/{key} isn't in the local manifest"]
    if not isinstance(entry.get("name"), str) or entry["name"].lower() != key:
        found.append(f"r/{key}'s entry is named {entry.get('name')!r}")
    version = entry.get("version")
    if not isinstance(version, str) or not VERSION_NAME.match(version):
        return None, None, found + [f"r/{key} has not a usable version name: {version!r}"]
    was = (live.get("subreddits") or {}).get(key)
    was = was if isinstance(was, dict) else None
    if was and was.get("version") == version:
        found.append(f"r/{key}/{version}/ is already live: a new build needs a new version")
    why = log_problem(log, key) if log is not None else None
    if why:
        found.append(f"the publish log r/{key}/published.json {why}: fix or remove it by hand")
    elif log is not None and any(e["version"] == version for e in log["publishes"]):
        found.append(f"r/{key}/{version}/ was already published (it's in the publish log), so its files are on R2: "
                     "a new build needs a new version")
    listed = entry.get("files") if isinstance(entry.get("files"), dict) else {}
    for name in BUILD_FILES:
        rel = f"r/{key}/{version}/{name}.parquet"
        f = listed.get(name)
        if not isinstance(f, dict):
            found.append(f"r/{key}'s build has no {name} file")
        elif f.get("path") != rel:
            found.append(f"r/{key}'s {name} isn't at {rel}")
        elif rel not in sizes:
            found.append(f"{rel} isn't in the local build")
        elif sizes[rel] != f.get("bytes"):
            found.append(f"{rel} is {sizes[rel]} bytes, but the manifest says {f.get('bytes')}")
    for field in ("posts_to_utc", "comments_to_utc"):
        value = entry.get(field)
        if not is_time(value):
            found.append(f"r/{key} has no usable {field}")
        elif value > now:
            found.append(f"r/{key}'s {field} is in the future")
        elif was and is_time(was.get(field)) and value < was[field] and not allow_older:
            found.append(f"r/{key}'s {field} {value} is earlier than the live build's {was[field]}: "
                         "pass --allow-older to publish it anyway")
    if found:
        return None, None, found
    merged = {**live, "subreddits": dict(sorted({**live.get("subreddits", {}), key: entry}.items()))}
    live_version = was.get("version") if was else None
    publishes = (log["publishes"] if log is not None else []) + [{"version": version, "replaced": live_version, "utc": now}]
    new_log = {"format": LOG_FORMAT, "subreddit": key, "publishes": publishes[-LOG_KEEP:]}
    pruned = (log.get("pruned", []) if log is not None else []) + due_for_pruning(log, {live_version, version}, now)
    if pruned:
        new_log["pruned"] = pruned[-LOG_KEEP:]
    return merged, new_log, []


def read_json(path: Path, what: str):
    """A downloaded JSON file, or None when it's missing or empty (nothing live yet)."""
    try:
        text = path.read_text(encoding="utf-8").strip() if path.exists() else ""
    except OSError as err:
        raise SystemExit(f"can't read {what} {path}: {err}")
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError as err:
        raise SystemExit(f"{what} {path} isn't JSON: {err}")


def merge_one_main(argv: list[str], now: int | None) -> None:
    parser = argparse.ArgumentParser(prog="check_upload.py merge-one",
                                     description="get one subreddit's build ready to publish (see the top of this file)")
    parser.add_argument("--key", required=True, help="the subreddit's key (its name, lowercase)")
    parser.add_argument("--dumps", required=True, type=Path, help="the build's output directory (manifest.json, r/)")
    parser.add_argument("--live", required=True, type=Path, help="the live manifest.json, as downloaded")
    parser.add_argument("--log", required=True, type=Path, help="the live r/KEY/published.json (missing or empty: none)")
    parser.add_argument("--out", required=True, type=Path, help="the bundle directory to write (must not exist)")
    parser.add_argument("--allow-older", action="store_true", help="publish even if a cutoff goes backwards")
    args = parser.parse_args(argv)
    if args.out.exists():
        raise SystemExit(f"{args.out} already exists: a bundle is written afresh")
    local = read_json(args.dumps / "manifest.json", "the local manifest")
    if not isinstance(local, dict):
        raise SystemExit(f"{args.dumps / 'manifest.json'} isn't a manifest")
    live_bytes = args.live.read_bytes() if args.live.exists() else b""
    live = read_json(args.live, "the live manifest")
    try:
        old_log = read_json(args.log, "the publish log")
    except SystemExit:
        old_log = "unreadable"  # merge_one reports it: the log is only ever fixed by hand
    # The sizes of the files the entry could name, looked up only under DIR/r/KEY/<version>/.
    entry = (local.get("subreddits") or {}).get(args.key)
    version = entry.get("version") if isinstance(entry, dict) else None
    sizes = {}
    if KEY_NAME.match(args.key) and isinstance(version, str) and VERSION_NAME.match(version):
        for name in BUILD_FILES:
            rel = f"r/{args.key}/{version}/{name}.parquet"
            if (args.dumps / rel).is_file():
                sizes[rel] = (args.dumps / rel).stat().st_size
    merged, log, found = merge_one(local, live, args.key, sizes, old_log, int(now if now is not None else time.time()),
                                   args.allow_older)
    for problem in found:
        print(f"error: {problem}", file=sys.stderr)
    if found:
        sys.exit(1)
    out = args.out
    for rel in sizes:
        (out / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(args.dumps / rel, out / rel)

    # With \n line ends on any platform: publish_build.sh reads these in bash.
    def write(rel: str, text: str) -> None:
        (out / rel).write_text(text, encoding="utf-8", newline="\n")
    write("manifest.json", json.dumps(merged, indent=2) + "\n")
    write(f"r/{args.key}/published.json", json.dumps(log, indent=2) + "\n")
    write("key", args.key + "\n")
    write("version", version + "\n")
    write("live.sha256", hashlib.sha256(live_bytes).hexdigest() + "\n")
    prune = newly_pruned(old_log, log)
    if prune:
        write("prune", "".join(v + "\n" for v in prune))
    print(f"ready to publish r/{args.key}/{version}/ in {out}" + (f", then prune {', '.join(prune)}" if prune else ""))


def main(argv: list[str] | None = None, now: int | None = None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["merge-one"]:
        return merge_one_main(argv[1:], now)
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
