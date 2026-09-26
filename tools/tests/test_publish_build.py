"""Tests for tools/publish_build.sh, the one step of the archive sync that holds the R2 token
(docs/adr/0005). rclone and curl are fakes passed in RCLONE and CURL (never put on PATH):
the bucket is a local directory, and each call is logged. Run from the repo root:

  uv run --with duckdb --with pytest pytest tools
"""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_dumps  # noqa: E402
import check_upload  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools" / "publish_build.sh"
BASH = shutil.which("bash")
pytestmark = pytest.mark.skipif(BASH is None, reason="needs bash")

SUB = "Some_Sub"
T = 1_790_000_000
OLD = "2026-09-20T000000Z"
NEW = "2026-09-21T000000Z"
BUILD = f"r/some_sub/{NEW}"
NAMES = ("posts_by_author", "comments_by_author", "comments_by_link")
PUBLIC = "https://dumps.test"

FAKE_RCLONE = r'''#!/usr/bin/env bash
# rclone, for the tests: "r2:rpp-db/<path>" is $FAKE_BUCKET/<path>. Logs each call.
set -uo pipefail
printf 'rclone %s\n' "$*" >> "$FAKE_LOG"
local_path() { printf '%s%s' "$FAKE_BUCKET" "${1#r2:rpp-db}"; }
cmd=$1
shift
case "$cmd" in
  cat)
    f=$(local_path "$1")
    [ -f "$f" ] || { echo "object not found" >&2; exit 3; }
    cat "$f" ;;
  lsf)
    [ -z "${FAKE_LSF_ERROR:-}" ] || { echo "$FAKE_LSF_ERROR" >&2; exit 1; }
    d=$(local_path "$1")
    [ -d "$d" ] || { echo "error listing: directory not found" >&2; exit 3; }
    ls -1 "$d" ;;
  copy)
    d=$(local_path "$2")
    mkdir -p "$d"
    for f in "$1"/*.parquet; do
      t="$d/$(basename "$f")"
      if [ -e "$t" ] && ! cmp -s "$f" "$t"; then echo "can't modify an immutable file" >&2; exit 1; fi
      cp "$f" "$t"
    done
    # Another publish lands while the files go up.
    [ -z "${FAKE_PUBLISH_BETWEEN:-}" ] || printf '{"format": 1, "subreddits": {}}\n' > "$FAKE_BUCKET/manifest.json" ;;
  copyto)
    d=$(local_path "$2")
    mkdir -p "$(dirname "$d")"
    cp "$1" "$d" ;;
  *) echo "fake rclone: unexpected $cmd" >&2; exit 2 ;;
esac
'''

FAKE_CURL = r'''#!/usr/bin/env bash
# curl, for the tests: answers a range request for $FAKE_PUBLIC/<path> from $FAKE_BUCKET/<path>
# with the headers `curl -D -` prints. FAKE_SERVE=gzip or whole serves it wrong.
set -uo pipefail
printf 'curl %s\n' "$*" >> "$FAKE_LOG"
url=${!#}
f="$FAKE_BUCKET/${url#"$FAKE_PUBLIC"/}"
[ -f "$f" ] || { printf 'HTTP/2 404\r\n\r\n'; exit 0; }
size=$(wc -c < "$f")
size=${size//[[:space:]]/}
case "${FAKE_SERVE:-ok}" in
  ok) printf 'HTTP/2 206\r\ncontent-range: bytes 0-99/%s\r\n\r\n' "$size" ;;
  gzip) printf 'HTTP/2 206\r\ncontent-range: bytes 0-99/%s\r\ncontent-encoding: gzip\r\n\r\n' "$size" ;;
  whole) printf 'HTTP/2 200\r\ncontent-length: %s\r\n\r\n' "$size" ;;
esac
'''


def quiet(*_):
    pass


def jsonl(path: Path, rows: list[dict]) -> Path:
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return path


def rows(kind: str, lo: int, hi: int) -> list[dict]:
    if kind == "posts":
        return [{"id": f"p{i}", "author": f"user{i % 5}", "created_utc": T + i * 10, "subreddit": SUB} for i in range(lo, hi)]
    return [{"id": f"c{i}", "author": f"user{i % 7}", "created_utc": T + i * 3, "subreddit": SUB, "link_id": f"t3_p{i % 9}"}
            for i in range(lo, hi)]


@pytest.fixture
def world(tmp_path):
    """The bucket with a live build, and a bundle for a newer one, made the way the sync will:
    a splice onto the downloaded live build, then merge-one."""
    bucket = tmp_path / "bucket"
    build_dumps.build(SUB, jsonl(tmp_path / "p0.jsonl", rows("posts", 0, 50)), jsonl(tmp_path / "c0.jsonl", rows("comments", 0, 200)),
                      bucket, version=OLD, now=T + 1000, log=quiet)
    dumps = tmp_path / "dumps"
    shutil.copytree(bucket, dumps)
    build_dumps.build(SUB, jsonl(tmp_path / "p1.jsonl", rows("posts", 40, 90)), jsonl(tmp_path / "c1.jsonl", rows("comments", 150, 400)),
                      dumps, version=NEW, splice=dumps, cut=T + 400, posts_through=T + 1500, comments_through=T + 1500,
                      now=T + 2000, log=quiet)
    bundle = tmp_path / "bundle"
    check_upload.main(["merge-one", "--key", "some_sub", "--dumps", str(dumps), "--live", str(bucket / "manifest.json"),
                       "--log", str(tmp_path / "no-log.json"), "--out", str(bundle)], now=T + 2000)
    fakes = {}
    for name, text in (("rclone", FAKE_RCLONE), ("curl", FAKE_CURL)):
        fakes[name] = tmp_path / f"fake-{name}"
        fakes[name].write_bytes(text.encode())  # LF line endings, whatever the platform
        fakes[name].chmod(0o755)
    return {"bucket": bucket, "bundle": bundle, "calls": tmp_path / "calls.log", "fakes": fakes}


def publish(world, **env):
    base = {**os.environ, "RCLONE": world["fakes"]["rclone"].as_posix(), "CURL": world["fakes"]["curl"].as_posix(),
            "RCLONE_REMOTE": "r2", "R2_BUCKET": "rpp-db", "DUMPS_URL": PUBLIC, "FAKE_PUBLIC": PUBLIC,
            "FAKE_BUCKET": world["bucket"].as_posix(), "FAKE_LOG": world["calls"].as_posix()}
    return subprocess.run([BASH, SCRIPT.as_posix(), world["bundle"].as_posix()], env={**base, **env}, cwd=ROOT,
                          capture_output=True, text=True, timeout=60)


def calls(world) -> list[str]:
    return world["calls"].read_text(encoding="utf-8").splitlines() if world["calls"].exists() else []


def steps(world) -> list[str]:
    """Each call, as "rclone cat manifest.json", "curl posts_by_author.parquet", ..."""
    out = []
    for line in calls(world):
        words = line.split()
        if words[0] == "rclone":
            target = words[3] if words[1] in ("copy", "copyto") else words[2]
            out.append(f"rclone {words[1]} {target.rstrip('/').rsplit('/', 1)[-1]}")
        else:
            out.append(f"curl {words[-1].rsplit('/', 1)[-1]}")
    return out


def test_uploads_the_build_then_the_manifest_then_the_log(world):
    result = publish(world)
    assert result.returncode == 0, result.stderr
    assert steps(world) == [
        "rclone cat manifest.json",  # still the manifest the bundle was made from
        f"rclone lsf {NEW}",  # the build isn't there yet
        f"rclone copy {NEW}",
        "curl posts_by_author.parquet", "curl comments_by_author.parquet", "curl comments_by_link.parquet",
        "rclone cat manifest.json",  # and still, just before it's replaced
        "rclone copyto manifest.json",
        "rclone copyto published.json",
    ]
    bucket, bundle = world["bucket"], world["bundle"]
    for name in NAMES:
        assert (bucket / BUILD / f"{name}.parquet").read_bytes() == (bundle / BUILD / f"{name}.parquet").read_bytes()
    assert (bucket / "manifest.json").read_bytes() == (bundle / "manifest.json").read_bytes()
    assert (bucket / "r/some_sub/published.json").read_bytes() == (bundle / "r/some_sub/published.json").read_bytes()
    assert (bucket / f"r/some_sub/{OLD}/posts_by_author.parquet").is_file()  # the old build stays
    lines = calls(world)
    copy = next(line for line in lines if line.startswith("rclone copy "))
    assert "--immutable" in copy and "Cache-Control: public, max-age=31536000, immutable" in copy
    for line in lines:
        if line.startswith("rclone copyto "):
            assert "Cache-Control: public, max-age=300" in line and "Content-Type: application/json" in line
    assert "curl " in lines[3] and "Range: bytes=0-99" in lines[3]


def test_uploads_nothing_if_the_live_manifest_changed_since_the_bundle_was_made(world):
    (world["bucket"] / "manifest.json").write_text('{"format": 1, "subreddits": {}}\n', encoding="utf-8")
    result = publish(world)
    assert result.returncode != 0 and "changed" in result.stderr
    assert steps(world) == ["rclone cat manifest.json"]


def test_keeps_the_manifest_that_another_publish_put_up_meanwhile(world):
    result = publish(world, FAKE_PUBLISH_BETWEEN="1")
    assert result.returncode != 0 and "changed" in result.stderr
    assert not any(s.startswith("rclone copyto") for s in steps(world))
    assert json.loads((world["bucket"] / "manifest.json").read_text(encoding="utf-8")) == {"format": 1, "subreddits": {}}


def test_never_replaces_a_build(world):
    (world["bucket"] / BUILD).mkdir(parents=True)
    (world["bucket"] / BUILD / "posts_by_author.parquet").write_bytes(b"already here")
    result = publish(world)
    assert result.returncode != 0 and "already on R2" in result.stderr
    assert not any(s.startswith("rclone copy") for s in steps(world))


def test_stops_when_it_cant_tell_whether_the_build_is_there(world):
    result = publish(world, FAKE_LSF_ERROR="AccessDenied: no")
    assert result.returncode != 0 and "AccessDenied" in result.stderr
    assert not any(s.startswith("rclone copy") for s in steps(world))


@pytest.mark.parametrize("serve", ["gzip", "whole"])
def test_keeps_the_live_manifest_when_a_file_isnt_served_right(world, serve):
    live = (world["bucket"] / "manifest.json").read_bytes()
    result = publish(world, FAKE_SERVE=serve)
    assert result.returncode != 0 and "the live one still stands" in result.stderr
    assert not any(s.startswith("rclone copyto") for s in steps(world))
    assert (world["bucket"] / "manifest.json").read_bytes() == live


def tamper_symlink(bundle: Path):
    log = bundle / "r/some_sub/published.json"
    log.unlink()
    try:
        os.symlink(bundle / "manifest.json", log)
    except OSError:
        pytest.skip("can't make symlinks here")


@pytest.mark.parametrize("tamper", [
    lambda b: (b / "run.sh").write_text("echo hi\n"),  # anything else in the bundle
    lambda b: (b / BUILD / "extra.parquet").write_bytes(b"x" * 200),
    lambda b: (b / BUILD / "comments_by_link.parquet").unlink(),
    lambda b: (b / "key").write_text("Some_Sub\n"),
    lambda b: (b / "key").write_text("../x\n"),
    lambda b: (b / "key").write_text("some_sub\nother\n"),
    lambda b: (b / "version").write_text("..\n"),
    lambda b: (b / "version").write_text("../../x\n"),
    lambda b: (b / "live.sha256").write_text("abc\n"),
    lambda b: (b / "manifest.json").write_text('{"format": 1, "subreddits": {}}\n'),  # doesn't name the build
    tamper_symlink,
], ids=["extra file", "extra parquet", "missing file", "uppercase key", "key path", "two-line key",
        "dot version", "version path", "short sha", "manifest without the build", "symlink"])
def test_refuses_a_bundle_that_isnt_exactly_one_build_before_any_rclone_call(world, tamper):
    tamper(world["bundle"])
    result = publish(world)
    assert result.returncode != 0, result.stdout
    assert result.stderr.startswith("error:"), result.stderr
    assert calls(world) == []


def test_needs_its_tools(world):
    result = publish(world, RCLONE="/nonexistent/rclone")
    assert result.returncode != 0 and "isn't installed" in result.stderr
    assert calls(world) == []
