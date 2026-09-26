"""Tests for tools/upload_dumps.sh: the owner's uploads, whole (the default) or one subreddit
into the live manifest (--only KEY, through check_upload.py merge-one and publish_build.sh).
rclone, curl and check_dumps.sh are fakes passed in RCLONE, CURL and CHECK_DUMPS (never put on
PATH); the bucket, which the public URL serves too, is a local directory. Run from the repo
root:

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

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools" / "upload_dumps.sh"
BASH = shutil.which("bash")
pytestmark = pytest.mark.skipif(BASH is None or shutil.which("node") is None or shutil.which("uv") is None,
                                reason="needs bash, node and uv")
PUBLIC = "https://dumps.test"
T = 1_790_000_000

FAKE_RCLONE = r'''#!/usr/bin/env bash
# rclone, for the tests: "r2:rpp-db/<path>" is $FAKE_BUCKET/<path>. Logs each call.
set -uo pipefail
printf 'rclone %s\n' "$*" >> "$FAKE_LOG"
local_path() { printf '%s%s' "$FAKE_BUCKET" "${1#r2:rpp-db}"; }
cmd=$1
shift
recursive="" dirs=""
while [ $# -gt 0 ]; do
  case "$1" in
    -R) recursive=1; shift ;;
    --dirs-only) dirs=1; shift ;;
    --max-depth) shift 2 ;;
    *) break ;;
  esac
done
case "$cmd" in
  listremotes) echo "r2:" ;;
  cat)
    f=$(local_path "$1")
    [ -f "$f" ] || { echo "object not found" >&2; exit 3; }
    cat "$f" ;;
  lsf)
    d=$(local_path "$1")
    [ -d "$d" ] || { echo "error listing: directory not found" >&2; exit 3; }
    if [ -n "$recursive" ]; then (cd "$d" && find . -mindepth 1 -maxdepth 2 -type d | sed 's|^\./||; s|$|/|')
    elif [ -n "$dirs" ]; then ls -1p "$d" | grep '/$' || true
    else ls -1 "$d"; fi ;;
  copy)
    src=$1
    d=$(local_path "$2")
    (cd "$src" && find . -name '*.parquet') | while read -r f; do
      mkdir -p "$d/$(dirname "$f")"
      [ -e "$d/$f" ] || cp "$src/$f" "$d/$f"
    done ;;
  copyto)
    d=$(local_path "$2")
    mkdir -p "$(dirname "$d")"
    cp "$1" "$d" ;;
  purge) rm -rf "$(local_path "$1")" ;;
  *) echo "fake rclone: unexpected $cmd" >&2; exit 2 ;;
esac
'''

FAKE_CURL = r'''#!/usr/bin/env bash
# curl, for the tests: $FAKE_PUBLIC/<path> is $FAKE_BUCKET/<path>. With -D - it prints a range
# answer's headers; with -o FILE -w '%{http_code}' it saves the file and prints the status.
set -uo pipefail
printf 'curl %s\n' "$*" >> "$FAKE_LOG"
url=${!#}
path=${url#"$FAKE_PUBLIC"/}
f="$FAKE_BUCKET/${path%%\?*}"
out="" headers=""
while [ $# -gt 1 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    -D) headers=1; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$headers" ]; then
  [ -f "$f" ] || { printf 'HTTP/2 404\r\n\r\n'; exit 0; }
  size=$(wc -c < "$f")
  printf 'HTTP/2 206\r\ncontent-range: bytes 0-99/%s\r\n\r\n' "${size//[[:space:]]/}"
elif [ -f "$f" ]; then
  cp "$f" "$out"
  printf 200
else
  : > "$out"
  printf 404
fi
'''

FAKE_CHECK_DUMPS = r'''#!/usr/bin/env bash
# check_dumps.sh, for the tests: logs what it was asked to check.
printf 'check_dumps %s\n' "$*" >> "$FAKE_LOG"
'''


def quiet(*_):
    pass


def jsonl(path: Path, name: str, rows: list[dict]) -> Path:
    path.write_text("".join(json.dumps({**r, "subreddit": name}) + "\n" for r in rows), encoding="utf-8")
    return path


def rows(kind: str, lo: int, hi: int) -> list[dict]:
    if kind == "posts":
        return [{"id": f"p{t}", "author": f"u{t % 5}", "created_utc": t} for t in range(lo, hi, 600)]
    return [{"id": f"c{t}", "author": f"u{t % 7}", "created_utc": t, "link_id": f"t3_p{lo}"} for t in range(lo, hi, 300)]


def build(tmp_path: Path, name: str, out: Path, version: str, through: int) -> dict:
    prefix = f"{name}-{version}"
    return build_dumps.build(name, jsonl(tmp_path / f"{prefix}-p.jsonl", name, rows("posts", T - 9000, through)),
                             jsonl(tmp_path / f"{prefix}-c.jsonl", name, rows("comments", T - 9000, through)), out,
                             version=version, now=T, posts_through=through, comments_through=through, log=quiet)


@pytest.fixture
def world(tmp_path):
    """R2 with Some_Sub and Other live, and a local dumps/ holding only a newer Some_Sub."""
    bucket = tmp_path / "bucket"
    build(tmp_path, "Some_Sub", bucket, "old", T - 5000)
    build(tmp_path, "Other", bucket, "v1", T - 5000)
    dumps = tmp_path / "dumps"
    build(tmp_path, "Some_Sub", dumps, "new", T - 1000)
    fakes = {}
    for name, text in (("rclone", FAKE_RCLONE), ("curl", FAKE_CURL), ("check_dumps", FAKE_CHECK_DUMPS)):
        fakes[name] = tmp_path / f"fake-{name}"
        fakes[name].write_bytes(text.encode())
        fakes[name].chmod(0o755)
    return {"bucket": bucket, "dumps": dumps, "calls": tmp_path / "calls.log", "fakes": fakes, "tmp": tmp_path}


def upload(world, *args):
    # A real rclone reached by mistake finds no remotes, so it can't touch the owner's bucket.
    empty = world["tmp"] / "no-remotes.conf"
    empty.write_text("", encoding="utf-8")
    env = {**os.environ, "RCLONE_CONFIG": empty.as_posix(), "RCLONE": world["fakes"]["rclone"].as_posix(), "CURL": world["fakes"]["curl"].as_posix(),
           "CHECK_DUMPS": world["fakes"]["check_dumps"].as_posix(), "RCLONE_REMOTE": "r2", "R2_BUCKET": "rpp-db",
           "DUMPS_URL": PUBLIC, "FAKE_PUBLIC": PUBLIC, "FAKE_BUCKET": world["bucket"].as_posix(),
           "FAKE_LOG": world["calls"].as_posix()}
    return subprocess.run([BASH, SCRIPT.as_posix(), *args], env=env, cwd=ROOT, capture_output=True, text=True, timeout=180)


def calls(world) -> list[str]:
    return world["calls"].read_text(encoding="utf-8").splitlines() if world["calls"].exists() else []


def live(world) -> dict:
    return json.loads((world["bucket"] / "manifest.json").read_text(encoding="utf-8"))


def test_only_publishes_one_subreddit_into_the_live_manifest(world):
    before = live(world)
    result = upload(world, world["dumps"].as_posix(), "--only", "some_sub")
    assert result.returncode == 0, result.stderr
    after = live(world)["subreddits"]
    # The local dumps/ has no Other: a whole upload would drop it, --only keeps it as it's live.
    assert after["other"] == before["subreddits"]["other"]
    assert after["some_sub"]["version"] == "new"
    assert (world["bucket"] / "r/some_sub/new/posts_by_author.parquet").is_file()
    log = json.loads((world["bucket"] / "r/some_sub/published.json").read_text(encoding="utf-8"))
    assert [(p["version"], p["replaced"]) for p in log["publishes"]] == [("new", "old")]
    lines = calls(world)
    assert any("manifest.json?check=" in c for c in lines if c.startswith("curl"))
    assert [c for c in lines if c.startswith("check_dumps")] == ["check_dumps manifest", "check_dumps cors"]


def test_only_passes_allow_older_to_merge_one(world):
    shutil.rmtree(world["dumps"])
    build(world["tmp"], "Some_Sub", world["dumps"], "older", T - 6000)
    refused = upload(world, world["dumps"].as_posix(), "--only", "some_sub")
    assert refused.returncode != 0 and "earlier than the live" in refused.stderr and "nothing was uploaded" in refused.stderr
    assert not any(c.startswith("rclone copy") for c in calls(world))
    result = upload(world, world["dumps"].as_posix(), "--only", "some_sub", "--allow-older")
    assert result.returncode == 0, result.stderr
    assert live(world)["subreddits"]["some_sub"]["version"] == "older"


@pytest.mark.parametrize("key", ["Some_Sub", "../x", ""])
def test_only_refuses_what_isnt_a_key_before_anything_else(world, key):
    result = upload(world, world["dumps"].as_posix(), "--only", key)
    assert result.returncode != 0 and "--only" in result.stderr
    assert calls(world) == []


def test_only_needs_a_live_manifest(world):
    (world["bucket"] / "manifest.json").unlink()
    result = upload(world, world["dumps"].as_posix(), "--only", "some_sub")
    assert result.returncode != 0 and "goes up whole" in result.stderr
    assert not any(c.startswith("rclone copy") for c in calls(world))


def test_a_whole_upload_still_works_as_before(world):
    # The default path, with its tools now passed in too: every subreddit in dumps/ goes up and
    # the manifest replaces the live one whole (here, dropping Other on purpose).
    refused = upload(world, world["dumps"].as_posix())
    assert refused.returncode != 0 and "r/Other is live but not in this manifest" in refused.stderr
    assert not any(c.startswith("rclone copy") for c in calls(world))
    result = upload(world, world["dumps"].as_posix(), "--drop", "other")
    assert result.returncode == 0, result.stderr
    assert list(live(world)["subreddits"]) == ["some_sub"]
    assert live(world)["subreddits"]["some_sub"]["version"] == "new"
    assert [c.split()[1] for c in calls(world) if c.startswith("check_dumps")] == ["files", "manifest", "cors"]
