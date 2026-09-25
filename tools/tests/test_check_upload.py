"""Tests for tools/check_upload.py. Run from the repo root:

  uv run --with duckdb --with pytest pytest tools
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import check_upload  # noqa: E402


def sub(name: str, version: str, size: int = 100) -> dict:
    key = name.lower()
    return {
        "name": name,
        "version": version,
        "files": {
            kind: {"path": f"r/{key}/{version}/{kind}.parquet", "bytes": size}
            for kind in ("posts_by_author", "comments_by_author")
        },
    }


def manifest(*subs: dict, fmt: int = 1) -> dict:
    return {"format": fmt, "subreddits": {s["name"].lower(): s for s in subs}}


LIVE = manifest(sub("Hasan_Piker", "2026-09-01"), sub("Python", "v1"))


def test_a_new_build_alongside_the_live_ones_is_fine():
    local = manifest(sub("Hasan_Piker", "2026-09-20"), sub("Python", "v1"))
    builds = {"hasan_piker/2026-09-01", "python/v1"}
    assert check_upload.problems(local, LIVE, builds) == []


def test_the_first_upload_has_nothing_to_compare_with():
    assert check_upload.problems(manifest(sub("Python", "v1")), None, set()) == []


def test_a_local_manifest_missing_a_live_subreddit_would_drop_it():
    local = manifest(sub("Python", "v1"))
    found = check_upload.problems(local, LIVE, {"hasan_piker/2026-09-01", "python/v1"})
    assert len(found) == 1 and "r/Hasan_Piker" in found[0] and "drop" in found[0]
    # Dropping on purpose is allowed when named.
    assert check_upload.problems(local, LIVE, set(), allow_drop={"hasan_piker"}) == []


def test_a_version_already_on_r2_is_refused_for_a_new_build():
    # Rebuilt from the same dump after clearing dumps/: same default version name.
    local = manifest(sub("Hasan_Piker", "2026-09-10"), sub("Python", "v1"))
    found = check_upload.problems(local, LIVE, {"hasan_piker/2026-09-01", "hasan_piker/2026-09-10", "python/v1"})
    assert len(found) == 1 and "r/hasan_piker/2026-09-10/" in found[0] and "--version" in found[0]


def test_the_live_version_rebuilt_with_different_files_is_refused():
    local = manifest(sub("Hasan_Piker", "2026-09-01", size=999), sub("Python", "v1"))
    found = check_upload.problems(local, LIVE, {"hasan_piker/2026-09-01", "python/v1"})
    assert len(found) == 1 and "different files" in found[0]


def test_a_format_change_needs_saying_so():
    local = manifest(sub("Hasan_Piker", "2026-09-01"), sub("Python", "v1"), fmt=2)
    builds = {"hasan_piker/2026-09-01", "python/v1"}
    assert any("format" in p for p in check_upload.problems(local, LIVE, builds))
    assert check_upload.problems(local, LIVE, builds, allow_format_change=True) == []


def test_parse_builds_reads_rclone_lsf_output():
    listing = "hasan_piker/\nhasan_piker/2026-09-01/\npython/\npython/v1/\n\n"
    assert check_upload.parse_builds(listing) == {"hasan_piker/2026-09-01", "python/v1"}


def test_main_exits_nonzero_with_the_problems(tmp_path, capsys):
    (tmp_path / "local.json").write_text(json.dumps(manifest(sub("Python", "v1"))), encoding="utf-8")
    (tmp_path / "live.json").write_text(json.dumps(LIVE), encoding="utf-8")
    (tmp_path / "builds.txt").write_text("python/\npython/v1/\n", encoding="utf-8")
    args = [str(tmp_path / n) for n in ("local.json", "live.json", "builds.txt")]
    with pytest.raises(SystemExit) as exit_:
        check_upload.main(args)
    assert exit_.value.code == 1
    assert "r/Hasan_Piker" in capsys.readouterr().err
    # An empty live-manifest file means there's no live manifest yet.
    (tmp_path / "live.json").write_text("", encoding="utf-8")
    check_upload.main(args)
    assert check_upload.main([*args[:1], args[1], args[2], "--drop", "hasan_piker"]) is None
