"""Tests for tools/build_dumps.py. Run from the repo root:

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


def jsonl(path: Path, rows: list[dict], tail: str = "") -> Path:
    path.write_text("".join(json.dumps(r) + "\n" for r in rows) + tail, encoding="utf-8")
    return path


def rows(path: Path, order: str) -> list[tuple]:
    return duckdb.sql(f"SELECT * FROM '{path.as_posix()}' ORDER BY {order}").fetchall()


@pytest.fixture
def dumps(tmp_path):
    posts = jsonl(tmp_path / "posts.jsonl", [
        {"id": "p2", "author": "Bob", "created_utc": 1_700_000_200, "subreddit": SUB, "title": "dropped"},
        {"id": "p1", "author": "alice", "created_utc": "1700000100", "subreddit": "some_sub"},
        {"id": "p1", "author": "alice", "created_utc": "1700000100", "subreddit": SUB},  # repeat
        {"id": "p3", "author": "[deleted]", "created_utc": 1_700_000_300, "subreddit": SUB},
        {"id": "p4", "author": "AutoModerator", "created_utc": 1_700_000_400, "subreddit": SUB},
        {"id": "p5", "author": "carol", "created_utc": 1_700_000_500, "subreddit": "Elsewhere"},
    ])
    comments = jsonl(tmp_path / "comments.jsonl", [
        {"id": "c1", "author": "Bob", "created_utc": 1_700_000_900.0, "subreddit": SUB, "link_id": "t3_p1", "body": "x"},
        {"id": "c2", "author": "alice", "created_utc": 1_700_000_800, "subreddit": SUB, "link_id": "t3_p1"},
        {"id": "c3", "author": "Bob", "created_utc": 1_700_000_700, "subreddit": SUB, "link_id": "t3_p2"},
        {"id": "c4", "author": "[deleted]", "created_utc": 1_700_000_600, "subreddit": SUB, "link_id": "t3_p2"},
        {"id": "c5", "author": "dave", "subreddit": SUB, "link_id": "t3_p2"},  # no time
    ], tail='{"id": "c6", "author": "half-writ')  # a last line still being written
    return posts, comments


def test_builds_the_three_files_and_a_manifest(tmp_path, dumps):
    posts, comments = dumps
    out = tmp_path / "out"
    entry = build_dumps.build(SUB, posts, comments, out, now=1_800_000_000, log=lambda *_: None)

    base = out / "r" / "some_sub" / entry["version"]
    assert rows(base / "posts_by_author.parquet", "author, created_utc") == [
        ("alice", 1_700_000_100), ("bob", 1_700_000_200)]
    assert rows(base / "comments_by_author.parquet", "author, created_utc") == [
        ("alice", 1_700_000_800), ("bob", 1_700_000_700), ("bob", 1_700_000_900)]
    # Thread lookups keep the name as written, for display.
    assert rows(base / "comments_by_link.parquet", "link_id, created_utc") == [
        ("p1", "alice", 1_700_000_800), ("p1", "Bob", 1_700_000_900), ("p2", "Bob", 1_700_000_700)]

    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["format"] == build_dumps.FORMAT
    saved = manifest["subreddits"]["some_sub"]
    assert saved == entry
    assert saved["name"] == SUB and saved["built_utc"] == 1_800_000_000
    assert saved["posts_to_utc"] == 1_700_000_200 and saved["comments_to_utc"] == 1_700_000_900
    # Named after the day the data runs to (the earlier of the two kinds).
    assert saved["version"] == "2023-11-14"
    f = saved["files"]["comments_by_link"]
    assert f["path"] == "r/some_sub/2023-11-14/comments_by_link.parquet"
    assert f["rows"] == 3 and f["key"] == "link_id" and f["bytes"] == (out / f["path"]).stat().st_size


def test_only_the_needed_columns_are_kept(tmp_path, dumps):
    entry = build_dumps.build(SUB, *dumps, tmp_path / "out", log=lambda *_: None)
    base = tmp_path / "out" / "r" / "some_sub" / entry["version"]
    for name, cols in {"posts_by_author": ["author", "created_utc"],
                       "comments_by_author": ["author", "created_utc"],
                       "comments_by_link": ["link_id", "author", "created_utc"]}.items():
        described = duckdb.sql(f"DESCRIBE SELECT * FROM '{(base / (name + '.parquet')).as_posix()}'").fetchall()
        assert [c[0] for c in described] == cols
        assert described[-1][1] == "BIGINT"


def test_row_groups_follow_the_sort_key(tmp_path):
    posts = jsonl(tmp_path / "posts.jsonl", [
        {"id": f"p{i}", "author": f"user{i % 37:02d}", "created_utc": 1_700_000_000 + i, "subreddit": SUB}
        for i in range(12_000)])
    comments = jsonl(tmp_path / "comments.jsonl", [
        {"id": f"c{i}", "author": f"user{i % 41:02d}", "created_utc": 1_700_000_000 + i, "subreddit": SUB,
         "link_id": f"t3_p{i % 53}"} for i in range(12_000)])
    entry = build_dumps.build(SUB, posts, comments, tmp_path / "out", row_group=2048, log=lambda *_: None)
    assert entry["files"]["comments_by_author"]["row_groups"] >= 5  # check_sorted ran over several


def test_a_build_is_never_overwritten_and_the_manifest_keeps_other_subreddits(tmp_path, dumps):
    out = tmp_path / "out"
    build_dumps.build(SUB, *dumps, out, log=lambda *_: None)
    with pytest.raises(SystemExit, match="never overwritten"):
        build_dumps.build(SUB, *dumps, out, log=lambda *_: None)

    other = [jsonl(tmp_path / f"{k}2.jsonl", [dict(r, subreddit="Other") for r in
             map(json.loads, (tmp_path / f"{k}.jsonl").read_text(encoding="utf-8").splitlines()[:3])])
             for k in ("posts", "comments")]
    build_dumps.build("Other", *other, out, log=lambda *_: None)
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert list(manifest["subreddits"]) == ["other", "some_sub"]


def test_refuses_bad_names_and_wrong_files(tmp_path, dumps):
    with pytest.raises(SystemExit, match="not a subreddit name"):
        build_dumps.build("r/Some_Sub", *dumps, tmp_path / "out", log=lambda *_: None)
    for version in ("../x", "..", ".", "-x", "a/b"):
        with pytest.raises(SystemExit, match="not a usable version name"):
            build_dumps.build(SUB, *dumps, tmp_path / "out", version=version, log=lambda *_: None)
    assert not (tmp_path / "out").exists()
    with pytest.raises(SystemExit, match="no posts left"):
        build_dumps.build("Elsewhere2", *dumps, tmp_path / "out", log=lambda *_: None)


def in_file_order(path: Path) -> list[tuple]:
    return duckdb.sql(f"SELECT * FROM '{path.as_posix()}'").fetchall()


def test_files_are_stored_in_lowercase_author_order_across_row_groups(tmp_path):
    # Mixed case, where sorting by the name as written would give a different order
    # ("Zed" < "alice"), across several row groups: the page skips groups by their
    # min/max author, so the file itself must be in lowercase order, not just its rows.
    names = ["Zed", "alice", "Bob", "carol", "Dave"]
    posts = jsonl(tmp_path / "posts.jsonl", [
        {"id": f"p{i}", "author": names[i % 5], "created_utc": 1_700_000_000 + (i * 7919) % 5000, "subreddit": SUB}
        for i in range(5_000)])
    comments = jsonl(tmp_path / "comments.jsonl", [
        {"id": f"c{i}", "author": names[i % 5].upper(), "created_utc": 1_700_000_000 + i, "subreddit": SUB,
         "link_id": f"t3_p{i % 7}"} for i in range(5_000)])
    entry = build_dumps.build(SUB, posts, comments, tmp_path / "out", row_group=2048, log=lambda *_: None)
    for name in ("posts_by_author", "comments_by_author"):
        assert entry["files"][name]["row_groups"] >= 2
        stored = in_file_order(tmp_path / "out" / entry["files"][name]["path"])
        assert stored == sorted(stored), name
        assert {author for author, _ in stored} == {n.lower() for n in names}


def test_check_sorted_rejects_row_groups_out_of_order(tmp_path):
    path = tmp_path / "unsorted.parquet"
    duckdb.sql(f"""
        COPY (SELECT CASE WHEN i < 3000 THEN 'zed' ELSE 'alice' END AS author, i AS created_utc
              FROM range(6000) t(i))
        TO '{path.as_posix()}' (FORMAT parquet, ROW_GROUP_SIZE 2048)
    """)
    with pytest.raises(SystemExit, match="aren't in author order"):
        build_dumps.check_sorted(duckdb.connect(), path, "author")


def test_refuses_to_add_to_a_manifest_of_another_format(tmp_path, dumps):
    out = tmp_path / "out"
    out.mkdir()
    (out / "manifest.json").write_text(json.dumps({"format": build_dumps.FORMAT + 1, "subreddits": {}}), encoding="utf-8")
    with pytest.raises(SystemExit, match="has format"):
        build_dumps.build(SUB, *dumps, out, log=lambda *_: None)


def test_removed_authors_are_dropped_and_comments_without_a_post_skip_the_link_file(tmp_path):
    posts = jsonl(tmp_path / "posts.jsonl", [
        {"id": "p1", "author": "alice", "created_utc": 1_700_000_000, "subreddit": SUB},
        {"id": "p2", "author": "[removed]", "created_utc": 1_700_000_001, "subreddit": SUB}])
    comments = jsonl(tmp_path / "comments.jsonl", [
        {"id": "c1", "author": "bob", "created_utc": 1_700_000_002, "subreddit": SUB, "link_id": "t3_p1"},
        {"id": "c2", "author": "carol", "created_utc": 1_700_000_003, "subreddit": SUB}])  # no link_id
    entry = build_dumps.build(SUB, posts, comments, tmp_path / "out", log=lambda *_: None)
    base = tmp_path / "out"
    assert in_file_order(base / entry["files"]["posts_by_author"]["path"]) == [("alice", 1_700_000_000)]
    # A comment without a link_id still counts for its author, but can't be filed under a post.
    assert [a for a, _ in in_file_order(base / entry["files"]["comments_by_author"]["path"])] == ["bob", "carol"]
    assert in_file_order(base / entry["files"]["comments_by_link"]["path"]) == [("p1", "bob", 1_700_000_002)]


def test_main_builds_from_the_command_line(tmp_path, dumps, capsys):
    posts, comments = dumps
    out = tmp_path / "out"
    build_dumps.main(["--subreddit", SUB, "--posts", str(posts), "--comments", str(comments),
                      "--out", str(out), "--version", "v9", "--row-group", "4096"])
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["subreddits"]["some_sub"]["version"] == "v9"
    assert (out / "r" / "some_sub" / "v9" / "posts_by_author.parquet").is_file()
    assert "wrote" in capsys.readouterr().out
