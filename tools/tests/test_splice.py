"""Tests for tools/build_dumps.py --splice: the archive sync's builds (docs/adr/0005).

A splice keeps the live build's rows up to a cut, adds the rows fetched after it
(tools/fetch_subreddit.mjs), and records how far each kind is complete. Run from the repo root:

  uv run --with duckdb --with pytest pytest tools
"""

import json
import re
import sys
from pathlib import Path

import duckdb
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_dumps  # noqa: E402

SUB = "Some_Sub"
T = 1_700_000_000  # 2023-11-14 22:13:20 UTC
BUILT = T + 1000  # when the splice runs: its version is named after it
DUMPS_JS = (Path(__file__).resolve().parents[2] / "web" / "dumps.js").read_text(encoding="utf-8")
FILES = ("posts_by_author", "comments_by_author", "comments_by_link")


def quiet(*_):
    pass


def jsonl(path: Path, rows: list[dict]) -> Path:
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return path


def post(n, author, t, **extra):
    return {"id": f"p{n}", "author": author, "created_utc": t, "subreddit": SUB, **extra}


def comment(n, author, t, link, **extra):
    return {"id": f"c{n}", "author": author, "created_utc": t, "subreddit": SUB, "link_id": f"t3_{link}", **extra}


def in_file_order(path: Path) -> list[tuple]:
    return duckdb.sql(f"SELECT * FROM '{path.as_posix()}'").fetchall()


def contents(out: Path, entry: dict) -> dict:
    return {name: in_file_order(out / entry["files"][name]["path"]) for name in FILES}


BASE_POSTS = [post(1, "alice", T + 100), post(2, "Bob", T + 200), post(3, "alice", T + 300)]
BASE_COMMENTS = [comment(1, "bob", T + 150, "p1"), comment(2, "Alice", T + 250, "p1"), comment(3, "carol", T + 350, "p2")]


@pytest.fixture
def live(tmp_path):
    """The live archive as the sync downloads it: manifest.json and r/some_sub/base/, whose
    posts run to T+300 and comments to T+350."""
    out = tmp_path / "live"
    build_dumps.build(SUB, jsonl(tmp_path / "base_posts.jsonl", BASE_POSTS),
                      jsonl(tmp_path / "base_comments.jsonl", BASE_COMMENTS), out, version="base", now=T + 400, log=quiet)
    return out


def splice(tmp_path, live, posts, comments, cut, posts_through, comments_through, out=None, **kw):
    return build_dumps.build(SUB, jsonl(tmp_path / "new_posts.jsonl", posts), jsonl(tmp_path / "new_comments.jsonl", comments),
                             out or live, splice=live, cut=cut, posts_through=posts_through,
                             comments_through=comments_through, now=kw.pop("now", BUILT), log=quiet, **kw)


def test_a_splice_keeps_the_live_rows_up_to_the_cut_and_adds_the_fetched_rows_after_it(tmp_path, live):
    # Fetched from the cut on: post 3 and comment 3 again (they were after the cut), and new ones.
    entry = splice(tmp_path, live,
                   [post(3, "alice", T + 300), post(4, "dave", T + 400)],
                   [comment(3, "carol", T + 350, "p2"), comment(4, "Dave", T + 450, "p3")],
                   cut=T + 250, posts_through=T + 500, comments_through=T + 600)

    assert contents(live, entry) == {
        "posts_by_author": [("alice", T + 100), ("alice", T + 300), ("bob", T + 200), ("dave", T + 400)],
        "comments_by_author": [("alice", T + 250), ("bob", T + 150), ("carol", T + 350), ("dave", T + 450)],
        "comments_by_link": [("p1", "bob", T + 150), ("p1", "Alice", T + 250), ("p2", "carol", T + 350), ("p3", "Dave", T + 450)],
    }
    # Named after when it was built; complete up to what the fetch reached, which a quiet
    # subreddit takes past its newest row.
    assert entry["version"] == "2023-11-14T223000Z"
    assert (entry["built_utc"], entry["posts_to_utc"], entry["comments_to_utc"]) == (BUILT, T + 500, T + 600)
    files = entry["files"]
    assert (files["posts_by_author"]["from_utc"], files["posts_by_author"]["to_utc"]) == (T + 100, T + 400)
    assert (files["comments_by_link"]["from_utc"], files["comments_by_link"]["to_utc"]) == (T + 150, T + 450)
    assert [files[n]["rows"] for n in FILES] == [4, 4, 4]
    # The live build is left as it was, and the manifest points at the new one.
    assert (live / "r" / "some_sub" / "base" / "posts_by_author.parquet").is_file()
    manifest = json.loads((live / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["subreddits"] == {"some_sub": entry}


def test_the_page_accepts_a_spliced_builds_paths(tmp_path, live):
    entry = splice(tmp_path, live, [], [], cut=T + 300, posts_through=T + 500, comments_through=T + 500)
    file_path = re.search(r"const FILE_PATH = /(.+)/;", DUMPS_JS).group(1).replace("\\/", "/")
    for name in FILES:
        assert re.fullmatch(file_path, entry["files"][name]["path"]), entry["files"][name]["path"]


def test_a_repair_replaces_its_whole_window_with_what_was_fetched(tmp_path, live):
    # A week-style repair: cut well back. Post 3 is gone from the archive since, and post 5 and
    # comment 5 were archived late; everything after the cut is what the fetch found now.
    entry = splice(tmp_path, live,
                   [post(2, "Bob", T + 200), post(5, "erin", T + 180)],
                   [comment(5, "erin", T + 130, "p1"), comment(1, "bob", T + 150, "p1"), comment(2, "Alice", T + 250, "p1"),
                    comment(3, "carol", T + 350, "p2")],
                   cut=T + 120, posts_through=T + 500, comments_through=T + 600)
    got = contents(live, entry)
    assert got["posts_by_author"] == [("alice", T + 100), ("bob", T + 200), ("erin", T + 180)]
    assert got["comments_by_author"] == [("alice", T + 250), ("bob", T + 150), ("carol", T + 350), ("erin", T + 130)]
    assert got["comments_by_link"] == [("p1", "erin", T + 130), ("p1", "bob", T + 150), ("p1", "Alice", T + 250), ("p2", "carol", T + 350)]


def test_a_splice_matches_a_fresh_build_of_the_same_rows(tmp_path, live):
    cut, through = T + 250, T + 500
    fetched_posts = [
        post(3, "alice", T + 300), post(3, "alice", T + 300),  # a repeat
        post(6, "[deleted]", T + 310), post(7, "AutoModerator", T + 320),
        {"id": "p8", "author": "x", "created_utc": T + 330, "subreddit": "Elsewhere"},
        {"id": "p9", "author": "y", "subreddit": SUB},  # no time
        post(10, "frank", T + 240),  # before the cut: the live build has what's there
        post(11, "gina", T + 900),  # after the cutoff
        post(12, "Hal", T + 400, title="text isn't kept"),
    ]
    fetched_comments = [comment(3, "carol", T + 350, "p2"), comment(13, "Hal", T + 410, "p12"),
                        {"id": "c14", "author": "ivy", "created_utc": T + 420, "subreddit": SUB},  # no link
                        comment(15, "", T + 430, "p12")]
    entry = splice(tmp_path, live, fetched_posts, fetched_comments, cut=cut, posts_through=through, comments_through=through)

    def window(base, fetched):
        return ([r for r in base if r["created_utc"] <= cut] +
                [r for r in fetched if "created_utc" not in r or cut < int(r["created_utc"]) <= through])
    fresh_out = tmp_path / "fresh"
    fresh = build_dumps.build(SUB, jsonl(tmp_path / "fresh_posts.jsonl", window(BASE_POSTS, fetched_posts)),
                              jsonl(tmp_path / "fresh_comments.jsonl", window(BASE_COMMENTS, fetched_comments)),
                              fresh_out, version="fresh", log=quiet)
    assert contents(live, entry) == contents(fresh_out, fresh)
    same = ("rows", "row_groups", "key", "from_utc", "to_utc")
    assert ({n: {k: entry["files"][n][k] for k in same} for n in FILES} ==
            {n: {k: fresh["files"][n][k] for k in same} for n in FILES})


def test_an_empty_fetch_still_moves_the_cutoff(tmp_path, live):
    # No posts since the cut: the posts file is the live one's rows, complete to the new cutoff.
    entry = splice(tmp_path, live, [], [comment(3, "carol", T + 350, "p2")],
                   cut=T + 300, posts_through=T + 800, comments_through=T + 800)
    got = contents(live, entry)
    assert got["posts_by_author"] == [("alice", T + 100), ("alice", T + 300), ("bob", T + 200)]
    assert got["comments_by_author"] == [("alice", T + 250), ("bob", T + 150), ("carol", T + 350)]
    assert (entry["posts_to_utc"], entry["comments_to_utc"]) == (T + 800, T + 800)


def test_spliced_files_stay_sorted_by_their_key_across_row_groups(tmp_path):
    def posts(lo, hi):
        return [post(i, f"User{i % 37:02d}", T + i) for i in range(lo, hi)]

    def comments(lo, hi):
        return [comment(i, f"user{i % 41:02d}", T + i, f"p{i % 53}") for i in range(lo, hi)]
    live = tmp_path / "live"
    build_dumps.build(SUB, jsonl(tmp_path / "bp.jsonl", posts(0, 6000)), jsonl(tmp_path / "bc.jsonl", comments(0, 6000)),
                      live, version="base", row_group=2048, now=T + 7000, log=quiet)
    entry = build_dumps.build(SUB, jsonl(tmp_path / "np.jsonl", posts(4000, 9000)), jsonl(tmp_path / "nc.jsonl", comments(4000, 9000)),
                              live, splice=live, cut=T + 4999, posts_through=T + 9000, comments_through=T + 9000,
                              row_group=2048, now=T + 9500, log=quiet)
    for name, key_columns in (("posts_by_author", (0, 1)), ("comments_by_author", (0, 1)), ("comments_by_link", (0, 2))):
        assert entry["files"][name]["row_groups"] >= 3, name
        stored = in_file_order(live / entry["files"][name]["path"])
        keys = [tuple(row[i] for i in key_columns) for row in stored]
        assert keys == sorted(keys), name
        assert len(stored) == 9000, name  # every row once


def test_refuses_a_cut_that_would_leave_a_gap_and_a_cutoff_that_goes_backwards(tmp_path, live):
    with pytest.raises(SystemExit, match="after the live build's posts cutoff"):
        splice(tmp_path, live, [], [], cut=T + 320, posts_through=T + 500, comments_through=T + 500)
    with pytest.raises(SystemExit, match="earlier than the live build's comments cutoff"):
        splice(tmp_path, live, [], [], cut=T + 250, posts_through=T + 500, comments_through=T + 340)
    with pytest.raises(SystemExit, match="in the future"):
        splice(tmp_path, live, [], [], cut=T + 250, posts_through=T + 500, comments_through=BUILT + 1)
    assert sorted(p.name for p in (live / "r" / "some_sub").iterdir()) == ["base"]


def test_refuses_half_a_splice(tmp_path, live):
    posts, comments = jsonl(tmp_path / "p.jsonl", []), jsonl(tmp_path / "c.jsonl", [])
    with pytest.raises(SystemExit, match="--cut needs --splice"):
        build_dumps.build(SUB, posts, comments, tmp_path / "out", cut=T, log=quiet)
    for missing in ("cut", "posts_through", "comments_through"):
        args = {"cut": T + 250, "posts_through": T + 500, "comments_through": T + 500, missing: None}
        with pytest.raises(SystemExit, match="a splice needs --cut, --posts-through and --comments-through"):
            build_dumps.build(SUB, posts, comments, live, splice=live, now=BUILT, log=quiet, **args)


def test_refuses_a_live_build_it_cant_trust(tmp_path, live):
    manifest_path = live / "manifest.json"
    good = json.loads(manifest_path.read_text(encoding="utf-8"))

    def attempt(match):
        with pytest.raises(SystemExit, match=match):
            splice(tmp_path, live, [], [], cut=T + 250, posts_through=T + 500, comments_through=T + 500)
        manifest_path.write_text(json.dumps(good), encoding="utf-8")

    manifest_path.write_text(json.dumps({**good, "format": build_dumps.FORMAT + 1}), encoding="utf-8")
    attempt("has format")
    manifest_path.write_text(json.dumps({**good, "subreddits": {}}), encoding="utf-8")
    attempt("isn't in")
    for bad in ("../../x", "base/..", ""):
        entry = {**good["subreddits"]["some_sub"], "version": bad}
        manifest_path.write_text(json.dumps({**good, "subreddits": {"some_sub": entry}}), encoding="utf-8")
        attempt("not a usable version name")
    entry = json.loads(json.dumps(good["subreddits"]["some_sub"]))
    entry["files"]["posts_by_author"]["path"] = "r/some_sub/base/../../elsewhere.parquet"
    manifest_path.write_text(json.dumps({**good, "subreddits": {"some_sub": entry}}), encoding="utf-8")
    attempt("isn't at r/some_sub/base/posts_by_author.parquet")
    entry = json.loads(json.dumps(good["subreddits"]["some_sub"]))
    entry["posts_to_utc"] = "soon"
    manifest_path.write_text(json.dumps({**good, "subreddits": {"some_sub": entry}}), encoding="utf-8")
    attempt("posts_to_utc")

    link = live / "r" / "some_sub" / "base" / "comments_by_link.parquet"
    saved = link.read_bytes()
    link.write_bytes(saved + b"x")  # not the file the manifest describes: a partial or wrong download
    attempt("the manifest says")
    link.unlink()
    attempt("no such file")
    link.write_bytes(saved)

    def swap(content: bytes | None, match: str):
        # A file of the size the manifest gives, but not a build's.
        path = live / "r" / "some_sub" / "base" / "posts_by_author.parquet"
        kept = path.read_bytes()
        if content is None:
            duckdb.sql(f"COPY (SELECT 'x' AS name, 1 AS created_utc) TO '{path.as_posix()}' (FORMAT parquet)")
        else:
            path.write_bytes(content)
        entry = json.loads(json.dumps(good["subreddits"]["some_sub"]))
        entry["files"]["posts_by_author"]["bytes"] = path.stat().st_size
        manifest_path.write_text(json.dumps({**good, "subreddits": {"some_sub": entry}}), encoding="utf-8")
        attempt(match)
        path.write_bytes(kept)
    swap(None, "has columns")
    swap(b"not a parquet file", "can't read")
    manifest_path.unlink()
    with pytest.raises(SystemExit, match="can't read"):
        splice(tmp_path, live, [], [], cut=T + 250, posts_through=T + 500, comments_through=T + 500)
    assert sorted(p.name for p in (live / "r" / "some_sub").iterdir()) == ["base"]


def test_through_in_a_build_from_jsonl_alone_sets_the_cutoff_and_drops_later_rows(tmp_path):
    # The first build of a subreddit fetched from its start: complete up to where the fetch got.
    out = tmp_path / "out"
    entry = build_dumps.build(SUB, jsonl(tmp_path / "p.jsonl", BASE_POSTS), jsonl(tmp_path / "c.jsonl", BASE_COMMENTS),
                              out, posts_through=T + 250, comments_through=T + 900, now=BUILT, log=quiet)
    assert (entry["posts_to_utc"], entry["comments_to_utc"]) == (T + 250, T + 900)
    assert in_file_order(out / entry["files"]["posts_by_author"]["path"]) == [("alice", T + 100), ("bob", T + 200)]
    assert entry["version"] == "2023-11-14"  # still named after the day the data runs to


def test_main_splices_into_the_downloaded_archive_keeping_other_subreddits(tmp_path, live, capsys):
    other = [jsonl(tmp_path / f"o{k}.jsonl", [dict(r, subreddit="Other") for r in rows])
             for k, rows in (("p", BASE_POSTS), ("c", BASE_COMMENTS))]
    build_dumps.build("Other", *other, live, version="v1", log=quiet)
    before = json.loads((live / "manifest.json").read_text(encoding="utf-8"))["subreddits"]["other"]
    build_dumps.main([
        "--subreddit", SUB,
        "--posts", str(jsonl(tmp_path / "np.jsonl", [post(4, "dave", T + 400)])),
        "--comments", str(jsonl(tmp_path / "nc.jsonl", [])),
        "--splice", str(live), "--cut", str(T + 300),
        "--posts-through", str(T + 500), "--comments-through", str(T + 500), "--out", str(live),
    ])
    manifest = json.loads((live / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["subreddits"]["other"] == before
    version = manifest["subreddits"]["some_sub"]["version"]
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d{6}Z", version)
    assert (live / "r" / "some_sub" / version / "posts_by_author.parquet").is_file()
    out = capsys.readouterr().out
    assert "kept" in out and "wrote" in out
