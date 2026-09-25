"""Tests for how tools/build_dumps.py configures DuckDB: where it spills, how much memory
it may use and whether it keeps insertion order (issue #54). Run from the repo root:

  uv run --with duckdb --with pytest pytest tools
"""

import json
import sys
from pathlib import Path

import duckdb
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_dumps  # noqa: E402

SUB = "Some_Sub"


def setting(con: duckdb.DuckDBPyConnection, name: str):
    return con.execute(f"SELECT current_setting('{name}')").fetchone()[0]


@pytest.fixture
def dumps(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    posts = src / "posts.jsonl"
    comments = src / "comments.jsonl"
    posts.write_text(json.dumps(
        {"id": "p1", "author": "alice", "created_utc": 1_700_000_100, "subreddit": SUB}) + "\n", encoding="utf-8")
    comments.write_text(json.dumps(
        {"id": "c1", "author": "Bob", "created_utc": 1_700_000_900, "subreddit": SUB, "link_id": "t3_p1"}) + "\n",
        encoding="utf-8")
    return posts, comments


def test_connect_spills_under_the_output_directory_outside_r(tmp_path):
    out = tmp_path / "out"
    con = build_dumps.connect(out)
    try:
        spill = Path(setting(con, "temp_directory"))
    finally:
        con.close()
    assert spill == out / ".tmp"
    assert (out / "r") not in spill.parents


def test_connect_turns_off_insertion_order(tmp_path):
    con = build_dumps.connect(tmp_path / "out")
    try:
        assert setting(con, "preserve_insertion_order") is False
    finally:
        con.close()


def test_connect_sets_the_memory_limit_only_when_given(tmp_path):
    default = duckdb.connect()
    expected = duckdb.connect(config={"memory_limit": "123MB"})
    limited = build_dumps.connect(tmp_path / "out", "123MB")
    unlimited = build_dumps.connect(tmp_path / "out")
    try:
        assert setting(limited, "memory_limit") == setting(expected, "memory_limit")
        assert setting(limited, "memory_limit") != setting(default, "memory_limit")
        assert setting(unlimited, "memory_limit") == setting(default, "memory_limit")
    finally:
        for con in (default, expected, limited, unlimited):
            con.close()


def test_memory_limit_flag_reaches_duckdb(tmp_path, dumps, monkeypatch):
    posts, comments = dumps
    seen = []
    real = build_dumps.connect

    def spy(out, memory_limit=None):
        con = real(out, memory_limit)
        seen.append(setting(con, "memory_limit"))
        return con

    monkeypatch.setattr(build_dumps, "connect", spy)
    monkeypatch.setattr("builtins.print", lambda *_: None)
    build_dumps.main(["--subreddit", SUB, "--posts", str(posts), "--comments", str(comments),
                      "--out", str(tmp_path / "out"), "--memory-limit", "123MB"])
    expected = duckdb.connect(config={"memory_limit": "123MB"})
    try:
        assert seen == [setting(expected, "memory_limit")]
    finally:
        expected.close()


def test_build_from_another_directory_leaves_no_tmp_behind(tmp_path, dumps, monkeypatch):
    posts, comments = dumps
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    out = tmp_path / "out"
    # A spill directory left by an earlier, interrupted build is cleaned up too.
    (out / ".tmp").mkdir(parents=True)
    (out / ".tmp" / "leftover.tmp").write_bytes(b"x")

    build_dumps.build(SUB, posts, comments, out, memory_limit="1GB", log=lambda *_: None)

    assert not (elsewhere / ".tmp").exists()
    assert list(elsewhere.iterdir()) == []
    assert not (out / ".tmp").exists()
    assert (out / "manifest.json").is_file()


def test_tmp_is_removed_when_the_build_fails(tmp_path, dumps):
    posts, _ = dumps
    empty = tmp_path / "src" / "empty.jsonl"
    empty.write_text("", encoding="utf-8")
    out = tmp_path / "out"
    with pytest.raises(SystemExit):
        build_dumps.build(SUB, posts, empty, out, log=lambda *_: None)
    assert not (out / ".tmp").exists()
