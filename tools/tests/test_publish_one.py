"""Tests for tools/check_upload.py merge-one: getting one subreddit's new build ready to publish
(the archive sync, docs/adr/0005), with no token. Run from the repo root:

  uv run --with duckdb --with pytest pytest tools
"""

import hashlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import check_upload  # noqa: E402

NOW = 1_790_000_000
NAMES = ("posts_by_author", "comments_by_author", "comments_by_link")


def sub(name: str, version: str, to_utc: int = NOW - 3600, size: int = 100) -> dict:
    key = name.lower()
    return {
        "name": name,
        "version": version,
        "built_utc": to_utc,
        "posts_to_utc": to_utc,
        "comments_to_utc": to_utc,
        "files": {n: {"path": f"r/{key}/{version}/{n}.parquet", "bytes": size} for n in NAMES},
    }


def manifest(*subs: dict, fmt: int = 1) -> dict:
    return {"format": fmt, "subreddits": {s["name"].lower(): s for s in subs}}


def sizes(entry: dict) -> dict:
    return {f["path"]: f["bytes"] for f in entry["files"].values()}


OLD = sub("Hasan_Piker", "2026-09-24", to_utc=NOW - 86400)
OTHER = sub("Python", "v1")
LIVE = manifest(OLD, OTHER)
NEW = sub("Hasan_Piker", "2026-09-21T120000Z")


def merge(local=None, live=LIVE, key="hasan_piker", files=None, log=None, **kw):
    local = local or manifest(NEW)
    entry = local["subreddits"].get(key)
    return check_upload.merge_one(local, live, key, files if files is not None else sizes(entry or NEW), log, NOW, **kw)


def test_merge_one_replaces_one_entry_of_the_live_manifest():
    # The local manifest's other entries don't count: a stale or partial dumps/ can't change them.
    stale_other = sub("Python", "v0")
    merged, log, problems = merge(local=manifest(NEW, stale_other))
    assert problems == []
    assert merged == {"format": 1, "subreddits": {"hasan_piker": NEW, "python": OTHER}}
    assert list(merged["subreddits"]) == ["hasan_piker", "python"]
    assert log == {"format": 1, "subreddit": "hasan_piker",
                   "publishes": [{"version": NEW["version"], "replaced": "2026-09-24", "utc": NOW}]}


def test_a_new_subreddit_is_added_and_replaces_nothing():
    fresh = sub("AskHistorians", "2026-09-21T120000Z")
    merged, log, problems = merge(local=manifest(fresh), key="askhistorians")
    assert problems == []
    assert list(merged["subreddits"]) == ["askhistorians", "hasan_piker", "python"]
    assert log["publishes"] == [{"version": fresh["version"], "replaced": None, "utc": NOW}]


def test_the_publish_log_grows_and_keeps_its_newest_entries():
    old = [{"version": f"2026-09-{d:02d}T000000Z", "replaced": None, "utc": NOW - 86400 * (30 - d)} for d in range(1, 21)]
    _, log, problems = merge(log={"format": 1, "subreddit": "hasan_piker", "publishes": old})
    assert problems == [] and log["publishes"] == old + [{"version": NEW["version"], "replaced": "2026-09-24", "utc": NOW}]
    many = [{"version": f"v{i}", "replaced": None, "utc": NOW - 5000 + i} for i in range(check_upload.LOG_KEEP)]
    _, log, _ = merge(log={"format": 1, "subreddit": "hasan_piker", "publishes": many})
    assert len(log["publishes"]) == check_upload.LOG_KEEP
    assert log["publishes"][0]["version"] == "v1" and log["publishes"][-1]["version"] == NEW["version"]


@pytest.mark.parametrize("change, expected", [
    (lambda: {"live": None}, "no live manifest"),
    (lambda: {"local": manifest(NEW, fmt=2)}, "format"),
    (lambda: {"key": "../x"}, "not a subreddit key"),
    (lambda: {"local": manifest(OTHER)}, "isn't in the local manifest"),
    (lambda: {"local": {"format": 1, "subreddits": {"hasan_piker": {**NEW, "name": "Python"}}}}, "is named"),
    (lambda: {"local": manifest(sub("Hasan_Piker", "2026-09-24"))}, "already live"),
    (lambda: {"log": {"format": 1, "subreddit": "hasan_piker",
                      "publishes": [{"version": NEW["version"], "replaced": None, "utc": NOW - 60}]}}, "already published"),
    (lambda: {"local": manifest({**NEW, "version": "../2026"})}, "not a usable version"),
    (lambda: {"files": {}}, "isn't in"),
    (lambda: {"files": {**sizes(NEW), NEW["files"]["comments_by_link"]["path"]: 99}}, "bytes"),
    (lambda: {"local": manifest({**NEW, "files": {n: f for n, f in NEW["files"].items() if n != "comments_by_link"}})},
     "comments_by_link"),
    (lambda: {"local": manifest({**NEW, "files": {**NEW["files"], "posts_by_author": {
        "path": "r/hasan_piker/2026-09-24/posts_by_author.parquet", "bytes": 100}}})}, "isn't at"),
    (lambda: {"local": manifest({**NEW, "posts_to_utc": OLD["posts_to_utc"] - 1})}, "earlier than the live"),
    (lambda: {"local": manifest({**NEW, "comments_to_utc": NOW + 1})}, "in the future"),
    (lambda: {"local": manifest({**NEW, "posts_to_utc": "soon"})}, "posts_to_utc"),
    (lambda: {"log": ["not", "a", "log"]}, "publish log"),
    (lambda: {"log": {"format": 1, "subreddit": "python", "publishes": []}}, "publish log"),
    (lambda: {"log": {"format": 1, "subreddit": "hasan_piker", "publishes": [{"version": "../x", "utc": NOW}]}}, "publish log"),
])
def test_merge_one_refuses(change, expected):
    merged, log, problems = merge(**change())
    assert merged is None and log is None
    assert any(expected in p for p in problems), problems


def test_an_older_cutoff_is_allowed_when_asked_for():
    older = {**NEW, "posts_to_utc": OLD["posts_to_utc"] - 1}
    _, _, problems = merge(local=manifest(older), allow_older=True)
    assert problems == []


def bundle_inputs(tmp_path, entry=NEW, live=LIVE, log=None):
    """A dumps/ directory holding `entry`'s files, the live manifest and publish log as
    downloaded, for main."""
    dumps = tmp_path / "dumps"
    for f in entry["files"].values():
        path = dumps / f["path"]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"P" * f["bytes"])
    (dumps / "manifest.json").write_text(json.dumps(manifest(entry)), encoding="utf-8")
    live_path = tmp_path / "live.json"
    live_path.write_text(json.dumps(live, indent=2) + "\n", encoding="utf-8")
    log_path = tmp_path / "published.json"
    if log is not None:
        log_path.write_text(json.dumps(log), encoding="utf-8")
    return dumps, live_path, log_path


def test_main_writes_the_bundle_the_publish_job_uploads(tmp_path):
    dumps, live_path, log_path = bundle_inputs(tmp_path)
    out = tmp_path / "bundle"
    check_upload.main(["merge-one", "--key", "hasan_piker", "--dumps", str(dumps), "--live", str(live_path),
                       "--log", str(log_path), "--out", str(out)], now=NOW)
    listed = sorted(p.relative_to(out).as_posix() for p in out.rglob("*") if p.is_file())
    build = f"r/hasan_piker/{NEW['version']}"
    assert listed == sorted(["key", "version", "live.sha256", "manifest.json", "r/hasan_piker/published.json",
                             *(f"{build}/{n}.parquet" for n in NAMES)])
    assert (out / "key").read_text(encoding="utf-8") == "hasan_piker\n"
    assert (out / "version").read_text(encoding="utf-8") == NEW["version"] + "\n"
    # The publish job compares this with the live manifest's bytes just before replacing it.
    assert (out / "live.sha256").read_text(encoding="utf-8") == hashlib.sha256(live_path.read_bytes()).hexdigest() + "\n"
    assert json.loads((out / "manifest.json").read_text(encoding="utf-8"))["subreddits"] == {"hasan_piker": NEW, "python": OTHER}
    assert json.loads((out / "r/hasan_piker/published.json").read_text(encoding="utf-8"))["publishes"][-1]["version"] == NEW["version"]
    for n in NAMES:
        assert (out / build / f"{n}.parquet").read_bytes() == (dumps / build / f"{n}.parquet").read_bytes()


def test_main_writes_nothing_when_something_is_wrong(tmp_path, capsys):
    dumps, live_path, log_path = bundle_inputs(tmp_path)
    (dumps / NEW["files"]["posts_by_author"]["path"]).write_bytes(b"short")
    out = tmp_path / "bundle"
    args = ["merge-one", "--key", "hasan_piker", "--dumps", str(dumps), "--live", str(live_path),
            "--log", str(log_path), "--out", str(out)]
    with pytest.raises(SystemExit) as exit_info:
        check_upload.main(args, now=NOW)
    assert exit_info.value.code == 1
    assert "bytes" in capsys.readouterr().err
    assert not out.exists()
    # Nor over an earlier bundle.
    (dumps / NEW["files"]["posts_by_author"]["path"]).write_bytes(b"P" * 100)
    out.mkdir()
    with pytest.raises(SystemExit, match="already exists"):
        check_upload.main(args, now=NOW)


def test_main_still_checks_a_whole_upload_as_before(tmp_path):
    local = tmp_path / "local.json"
    local.write_text(json.dumps(LIVE), encoding="utf-8")
    live = tmp_path / "live.json"
    live.write_text(json.dumps(LIVE), encoding="utf-8")
    builds = tmp_path / "builds.txt"
    builds.write_text("hasan_piker/2026-09-24/\npython/v1/\n", encoding="utf-8")
    check_upload.main([str(local), str(live), str(builds)])
