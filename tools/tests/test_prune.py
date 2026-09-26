"""Tests for pruning replaced builds (the archive sync, docs/adr/0005): check_upload.py merge-one
plans it from the subreddit's publish log, and tools/publish_build.sh deletes after publishing.
A build goes only once the publish that replaced it is PRUNE_AFTER old, never while a manifest
names it, and never if the log doesn't know it. Run from the repo root:

  uv run --with duckdb --with pytest pytest tools
"""

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_dumps  # noqa: E402
import check_upload  # noqa: E402

HOUR = 3600
NOW = 1_790_000_000
NAMES = ("posts_by_author", "comments_by_author", "comments_by_link")


def sub(version: str) -> dict:
    return {"name": "Hasan_Piker", "version": version, "built_utc": NOW - HOUR, "posts_to_utc": NOW - HOUR,
            "comments_to_utc": NOW - HOUR,
            "files": {n: {"path": f"r/hasan_piker/{version}/{n}.parquet", "bytes": 100} for n in NAMES}}


def manifest(entry: dict) -> dict:
    return {"format": 1, "subreddits": {"hasan_piker": entry}}


def publish(version, replaced, hours_ago):
    return {"version": version, "replaced": replaced, "utc": NOW - hours_ago * HOUR}


LIVE_V = "2026-09-22T060000Z"
NEW_V = "2026-09-22T070000Z"
# The hand-made build, then three synced ones: the first two were replaced 100 and 80 hours
# ago, the third 71 hours ago (too recent), and the live one an hour ago.
LOG = {"format": 1, "subreddit": "hasan_piker", "publishes": [
    publish("2026-09-18T000000Z", "2026-09-10", 100),
    publish("2026-09-19T000000Z", "2026-09-18T000000Z", 80),
    publish("2026-09-19T010000Z", "2026-09-19T000000Z", 71),
    publish(LIVE_V, "2026-09-19T010000Z", 1),
]}


def merge(log, live_version=LIVE_V):
    new = sub(NEW_V)
    return check_upload.merge_one(manifest(new), manifest(sub(live_version)), "hasan_piker",
                                  {f["path"]: 100 for f in new["files"].values()}, log, NOW)


def next_publish(log, version="2026-09-22T080000Z", live=NEW_V):
    """The publish after `merge`'s, with its log."""
    return check_upload.merge_one(manifest(sub(version)), manifest(sub(live)), "hasan_piker",
                                  {f"r/hasan_piker/{version}/{n}.parquet": 100 for n in NAMES}, log, NOW)


def test_a_publish_prunes_the_builds_replaced_at_least_72_hours_ago():
    assert check_upload.PRUNE_AFTER == 72 * HOUR
    _, log, problems = merge(LOG)
    assert problems == []
    assert log["pruned"] == ["2026-09-10", "2026-09-18T000000Z"]
    assert log["publishes"][-1] == {"version": NEW_V, "replaced": LIVE_V, "utc": NOW}
    assert check_upload.newly_pruned(LOG, log) == ["2026-09-10", "2026-09-18T000000Z"]


def test_nothing_is_pruned_twice():
    _, log, _ = merge({**LOG, "pruned": ["2026-09-10"]})
    assert log["pruned"] == ["2026-09-10", "2026-09-18T000000Z"]
    assert check_upload.newly_pruned({**LOG, "pruned": ["2026-09-10"]}, log) == ["2026-09-18T000000Z"]
    _, again, problems = next_publish(log)
    assert problems == [] and check_upload.newly_pruned(log, again) == []


def test_the_live_build_and_the_new_one_are_never_pruned():
    # A log saying they were replaced long ago (a build put back by hand, say) doesn't count.
    odd = {**LOG, "publishes": [publish("x1", LIVE_V, 200), publish("x2", NEW_V, 150), *LOG["publishes"]]}
    _, log, problems = merge(odd)
    assert problems == [] and LIVE_V not in log["pruned"] and NEW_V not in log["pruned"]


def test_at_most_PRUNE_MAX_a_publish_oldest_first():
    many = [publish(f"2026-09-0{i + 1}T000000Z", f"old{i}", 200 - i) for i in range(8)]
    log0 = {"format": 1, "subreddit": "hasan_piker", "publishes": many + [publish(LIVE_V, "2026-09-08T000000Z", 1)]}
    _, log1, _ = merge(log0)
    assert log1["pruned"] == [f"old{i}" for i in range(check_upload.PRUNE_MAX)]
    # The next publish takes the rest.
    _, log2, _ = next_publish(log1)
    assert check_upload.newly_pruned(log1, log2) == [f"old{i}" for i in range(check_upload.PRUNE_MAX, 8)]


def test_a_log_without_prunes_keeps_its_shape():
    _, log, _ = merge({**LOG, "publishes": LOG["publishes"][-2:]})
    assert "pruned" not in log


def test_a_malformed_prune_record_is_refused():
    _, _, problems = merge({**LOG, "pruned": ["../x"]})
    assert any("publish log" in p for p in problems)
    _, _, problems = merge({**LOG, "pruned": "2026-09-10"})
    assert any("publish log" in p for p in problems)


def test_main_writes_the_prune_list_into_the_bundle(tmp_path):
    new = sub(NEW_V)
    dumps = tmp_path / "dumps"
    for f in new["files"].values():
        (dumps / f["path"]).parent.mkdir(parents=True, exist_ok=True)
        (dumps / f["path"]).write_bytes(b"P" * 100)
    (dumps / "manifest.json").write_text(json.dumps(manifest(new)), encoding="utf-8")
    (tmp_path / "live.json").write_text(json.dumps(manifest(sub(LIVE_V))), encoding="utf-8")
    (tmp_path / "log.json").write_text(json.dumps(LOG), encoding="utf-8")
    check_upload.main(["merge-one", "--key", "hasan_piker", "--dumps", str(dumps), "--live", str(tmp_path / "live.json"),
                       "--log", str(tmp_path / "log.json"), "--out", str(tmp_path / "bundle")], now=NOW)
    assert (tmp_path / "bundle" / "prune").read_text(encoding="utf-8") == "2026-09-10\n2026-09-18T000000Z\n"


# publish_build.sh ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools" / "publish_build.sh"
BASH = shutil.which("bash")
needs_bash = pytest.mark.skipif(BASH is None, reason="needs bash")
PUBLIC = "https://dumps.test"
SUB = "Hasan_Piker"
T = 1_790_000_000

FAKE_RCLONE = r'''#!/usr/bin/env bash
# rclone, for the tests: "r2:rpp-db/<path>" is $FAKE_BUCKET/<path>. Logs each call.
set -uo pipefail
printf 'rclone %s\n' "$*" >> "$FAKE_LOG"
local_path() { printf '%s%s' "$FAKE_BUCKET" "${1#r2:rpp-db}"; }
cmd=$1
shift
dirs=""
if [ "${1:-}" = --dirs-only ]; then dirs=1; shift; fi
case "$cmd" in
  cat)
    f=$(local_path "$1")
    [ -f "$f" ] || { echo "object not found" >&2; exit 3; }
    cat "$f" ;;
  lsf)
    d=$(local_path "$1")
    [ -d "$d" ] || { echo "error listing: directory not found" >&2; exit 3; }
    if [ -n "$dirs" ]; then ls -1p "$d" | grep '/$' || true; else ls -1 "$d"; fi ;;
  copy)
    d=$(local_path "$2")
    mkdir -p "$d"
    for f in "$1"/*.parquet; do cp "$f" "$d/"; done ;;
  copyto)
    d=$(local_path "$2")
    mkdir -p "$(dirname "$d")"
    cp "$1" "$d" ;;
  purge)
    [ -z "${FAKE_PURGE_ERROR:-}" ] || { echo "$FAKE_PURGE_ERROR" >&2; exit 1; }
    d=$(local_path "$1")
    [ -d "$d" ] || { echo "error: directory not found" >&2; exit 3; }
    rm -rf "$d" ;;
  *) echo "fake rclone: unexpected $cmd" >&2; exit 2 ;;
esac
'''

FAKE_CURL = r'''#!/usr/bin/env bash
# curl, for the tests: a range request for $FAKE_PUBLIC/<path>, answered from $FAKE_BUCKET/<path>.
set -uo pipefail
printf 'curl %s\n' "$*" >> "$FAKE_LOG"
url=${!#}
f="$FAKE_BUCKET/${url#"$FAKE_PUBLIC"/}"
[ -f "$f" ] || { printf 'HTTP/2 404\r\n\r\n'; exit 0; }
size=$(wc -c < "$f")
printf 'HTTP/2 206\r\ncontent-range: bytes 0-99/%s\r\n\r\n' "${size//[[:space:]]/}"
'''

OLD = "2026-09-20T000000Z"  # live
GONE_A = "2026-09-10"  # the hand-made build, replaced 100 h ago
GONE_B = "2026-09-18T000000Z"  # replaced 80 h ago
KEEP = "2026-09-19T000000Z"  # replaced 71 h ago: too recent
STRAY = "2026-08-01"  # on R2 but in no log: reported, never deleted
BUCKET_LOG = {"format": 1, "subreddit": "hasan_piker", "publishes": [
    {"version": GONE_B, "replaced": GONE_A, "utc": T - 100 * HOUR},
    {"version": KEEP, "replaced": GONE_B, "utc": T - 80 * HOUR},
    {"version": OLD, "replaced": KEEP, "utc": T - 71 * HOUR},
]}


def jsonl(path: Path, rows: list[dict]) -> Path:
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return path


@pytest.fixture
def world(tmp_path):
    """A bucket with the live build, older ones and a stray one, and a bundle for a newer build
    whose log has two builds due for pruning."""
    bucket = tmp_path / "bucket"
    posts = [{"id": f"p{i}", "author": f"u{i % 3}", "created_utc": T - 9000 + i * 10, "subreddit": SUB} for i in range(30)]
    comments = [{"id": f"c{i}", "author": f"u{i % 4}", "created_utc": T - 9000 + i * 5, "subreddit": SUB,
                 "link_id": f"t3_p{i % 5}"} for i in range(80)]
    quiet = lambda *_: None  # noqa: E731
    build_dumps.build(SUB, jsonl(tmp_path / "p.jsonl", posts), jsonl(tmp_path / "c.jsonl", comments), bucket,
                      version=OLD, now=T - 8000, log=quiet)
    for v in (GONE_A, GONE_B, KEEP, STRAY):
        (bucket / "r/hasan_piker" / v).mkdir(parents=True)
        (bucket / "r/hasan_piker" / v / "posts_by_author.parquet").write_bytes(b"old build")
    (bucket / "r/hasan_piker/published.json").write_text(json.dumps(BUCKET_LOG), encoding="utf-8")
    dumps = tmp_path / "dumps"
    shutil.copytree(bucket, dumps)
    new = "2026-09-21T000000Z"
    more = [{"id": f"p{i}", "author": "u9", "created_utc": T - 8500 + i, "subreddit": SUB} for i in range(30, 40)]
    build_dumps.build(SUB, jsonl(tmp_path / "p2.jsonl", more), jsonl(tmp_path / "c2.jsonl", []), dumps, version=new,
                      splice=dumps, cut=T - 8710, posts_through=T - 7000, comments_through=T - 7000, now=T, log=quiet)
    bundle = tmp_path / "bundle"
    check_upload.main(["merge-one", "--key", "hasan_piker", "--dumps", str(dumps), "--live", str(bucket / "manifest.json"),
                       "--log", str(bucket / "r/hasan_piker/published.json"), "--out", str(bundle)], now=T)
    fakes = {}
    for name, text in (("rclone", FAKE_RCLONE), ("curl", FAKE_CURL)):
        fakes[name] = tmp_path / f"fake-{name}"
        fakes[name].write_bytes(text.encode())
        fakes[name].chmod(0o755)
    return {"bucket": bucket, "bundle": bundle, "new": new, "calls": tmp_path / "calls.log", "fakes": fakes}


def run(world, **env):
    base = {**os.environ, "RCLONE": world["fakes"]["rclone"].as_posix(), "CURL": world["fakes"]["curl"].as_posix(),
            "RCLONE_REMOTE": "r2", "R2_BUCKET": "rpp-db", "DUMPS_URL": PUBLIC, "FAKE_PUBLIC": PUBLIC,
            "FAKE_BUCKET": world["bucket"].as_posix(), "FAKE_LOG": world["calls"].as_posix()}
    return subprocess.run([BASH, SCRIPT.as_posix(), world["bundle"].as_posix()], env={**base, **env}, cwd=ROOT,
                          capture_output=True, text=True, timeout=60)


def calls(world) -> list[str]:
    return world["calls"].read_text(encoding="utf-8").splitlines() if world["calls"].exists() else []


def builds(world) -> list[str]:
    return sorted(p.name for p in (world["bucket"] / "r/hasan_piker").iterdir() if p.is_dir())


@needs_bash
def test_publishing_prunes_what_the_bundle_lists_after_the_manifest_and_log(world):
    assert (world["bundle"] / "prune").read_text(encoding="utf-8") == f"{GONE_A}\n{GONE_B}\n"
    result = run(world)
    assert result.returncode == 0, result.stderr
    assert builds(world) == sorted([OLD, KEEP, STRAY, world["new"]])
    lines = calls(world)
    after = [line.split()[1:3] for line in lines[lines.index(next(c for c in lines if "published.json" in c and "copyto" in c)) + 1:]]
    assert after == [["purge", f"r2:rpp-db/r/hasan_piker/{GONE_A}"], ["purge", f"r2:rpp-db/r/hasan_piker/{GONE_B}"],
                     ["lsf", "--dirs-only"]]
    # Builds R2 has that the log doesn't know are named, never deleted.
    assert f"r/hasan_piker/{STRAY}/" in result.stderr and "by hand" in result.stderr
    assert f"r/hasan_piker/{KEEP}/" not in result.stderr


@needs_bash
def test_a_build_already_gone_is_fine(world):
    shutil.rmtree(world["bucket"] / "r/hasan_piker" / GONE_A)
    result = run(world)
    assert result.returncode == 0, result.stderr
    assert GONE_B not in builds(world)


@needs_bash
def test_a_failed_prune_is_reported_after_the_publish_stands(world):
    result = run(world, FAKE_PURGE_ERROR="AccessDenied")
    assert result.returncode != 0 and "AccessDenied" in result.stderr and "not every build due was pruned" in result.stderr
    assert json.loads((world["bucket"] / "manifest.json").read_text(encoding="utf-8"))["subreddits"]["hasan_piker"]["version"] == world["new"]
    assert (world["bucket"] / "r/hasan_piker/published.json").read_bytes() == (world["bundle"] / "r/hasan_piker/published.json").read_bytes()


@needs_bash
def test_never_prunes_a_build_the_live_manifest_names(world):
    (world["bundle"] / "prune").write_text(f"{OLD}\n", encoding="utf-8", newline="")
    result = run(world)
    assert result.returncode != 0 and f"kept r/hasan_piker/{OLD}/" in result.stderr
    assert OLD in builds(world)
    assert not any(" purge " in f" {c} " for c in calls(world))


@needs_bash
def test_prunes_only_what_the_log_on_r2_says_was_replaced(world):
    # The bundle comes from a job without the token, so its list isn't taken on trust: R2's own
    # publish log, read before this publish replaces it, must say each build was replaced.
    (world["bundle"] / "prune").write_text(f"{STRAY}\n{GONE_A}\n", encoding="utf-8", newline="")
    result = run(world)
    assert result.returncode != 0 and f"kept r/hasan_piker/{STRAY}/" in result.stderr
    assert STRAY in builds(world) and GONE_A not in builds(world)
    lines = calls(world)
    read = next(i for i, c in enumerate(lines) if c.startswith("rclone cat") and "published.json" in c)
    assert read < next(i for i, c in enumerate(lines) if c.startswith("rclone copy "))


@needs_bash
def test_with_no_log_on_r2_nothing_is_pruned(world):
    (world["bucket"] / "r/hasan_piker/published.json").unlink()
    result = run(world)
    assert result.returncode != 0 and f"kept r/hasan_piker/{GONE_A}/" in result.stderr
    assert GONE_A in builds(world) and GONE_B in builds(world)


@needs_bash
@pytest.mark.parametrize("prune", [
    "2026-09-21T000000Z\n",  # the build being published
    "../x\n",
    "a\nb\nc\nd\ne\nf\n",  # more than PRUNE_MAX
    "2026-09-10\r\n",
], ids=["the new build", "a path", "too many", "CRLF"])
def test_refuses_a_prune_list_that_doesnt_check_out_before_any_rclone_call(world, prune):
    (world["bundle"] / "prune").write_text(prune, encoding="utf-8", newline="")
    result = run(world)
    assert result.returncode != 0 and result.stderr.startswith("error:"), result.stderr
    assert calls(world) == []


@needs_bash
@pytest.mark.parametrize("indent", [None, 2], ids=["compact", "as merge-one writes it"])
def test_keeps_a_build_r2s_log_says_was_replaced_less_than_72_hours_ago(world, indent):
    # The grace is checked here too, against R2's own log and the clock, not taken on trust
    # from the bundle's list: a job without the token made that.
    publishes = [dict(p) for p in BUCKET_LOG["publishes"]]
    publishes[1]["utc"] = int(time.time()) - 10 * HOUR  # GONE_B's replacement
    log = {**BUCKET_LOG, "publishes": publishes}
    (world["bucket"] / "r/hasan_piker/published.json").write_text(json.dumps(log, indent=indent), encoding="utf-8")
    result = run(world)
    assert result.returncode != 0 and f"kept r/hasan_piker/{GONE_B}/" in result.stderr and "72 h" in result.stderr
    assert GONE_B in builds(world) and GONE_A not in builds(world)
