"""The contract between tools/build_dumps.py and the page's reader, web/dumps.js.

The page's tests read committed Parquet fixtures (web/tests/fixtures/dumps), built by the
script from the JSONL in web/tests/fixtures/dumps-src. If the script changes what it
writes (columns, types, sort order, file names, the manifest) or FORMAT, these fail until
the fixtures are rebuilt and the page is updated to match, instead of both test suites
passing on stale fixtures while the live page breaks.

Run from the repo root:  uv run --with duckdb --with pytest pytest tools
"""

import json
import re
import sys
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_dumps  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "web" / "tests" / "fixtures" / "dumps"
SOURCES = ROOT / "web" / "tests" / "fixtures" / "dumps-src"
DUMPS_JS = (ROOT / "web" / "dumps.js").read_text(encoding="utf-8")

REBUILD = (
    "the committed fixtures don't match what build_dumps.py writes now; rebuild them: delete "
    "web/tests/fixtures/dumps, then run  uv run tools/build_dumps.py --subreddit Python "
    "--posts web/tests/fixtures/dumps-src/posts.jsonl --comments web/tests/fixtures/dumps-src/comments.jsonl "
    "--out web/tests/fixtures/dumps --version v1  (and update web/dumps.js if the shape changed)"
)


def in_file_order(path: Path) -> list[tuple]:
    return duckdb.sql(f"SELECT * FROM '{path.as_posix()}'").fetchall()


def schema(path: Path) -> list[tuple]:
    return [(c[0], c[1]) for c in duckdb.sql(f"DESCRIBE SELECT * FROM '{path.as_posix()}'").fetchall()]


def row_groups(path: Path) -> int:
    return duckdb.sql(f"SELECT count(DISTINCT row_group_id) FROM parquet_metadata('{path.as_posix()}')").fetchone()[0]


def test_the_committed_fixtures_match_a_fresh_build(tmp_path):
    committed = json.loads((FIXTURES / "manifest.json").read_text(encoding="utf-8"))
    entry = committed["subreddits"]["python"]
    fresh = build_dumps.build("Python", SOURCES / "posts.jsonl", SOURCES / "comments.jsonl", tmp_path,
                              version=entry["version"], now=entry["built_utc"], log=lambda *_: None)

    assert committed["format"] == build_dumps.FORMAT, REBUILD
    # Byte sizes depend on the DuckDB version that wrote the files, so compare the rest.
    strip = lambda e: {**e, "files": {n: {k: v for k, v in f.items() if k != "bytes"} for n, f in e["files"].items()}}
    assert strip(fresh) == strip(entry), REBUILD
    for name, f in entry["files"].items():
        old, new = FIXTURES / f["path"], tmp_path / f["path"]
        assert schema(new) == schema(old), f"{name}: {REBUILD}"
        assert in_file_order(new) == in_file_order(old), f"{name}: {REBUILD}"
        assert row_groups(new) == row_groups(old), f"{name}: {REBUILD}"
        assert old.stat().st_size == f["bytes"], f"{name}: the manifest's size is wrong; {REBUILD}"


def test_the_page_reads_the_format_the_script_writes():
    match = re.search(r"export const DUMP_FORMAT = (\d+);", DUMPS_JS)
    assert match, "DUMP_FORMAT not found in web/dumps.js"
    assert int(match.group(1)) == build_dumps.FORMAT, "bump FORMAT (build_dumps.py) and DUMP_FORMAT (dumps.js) together"


def test_the_page_reads_files_and_columns_the_script_writes(tmp_path):
    files = re.search(r"const FILES = \{ posts: \"(\w+)\", comments: \"(\w+)\" \};", DUMPS_JS)
    columns = re.search(r"columns: \[([^\]]+)\]", DUMPS_JS)
    assert files and columns, "FILES or the parquetQuery columns not found in web/dumps.js"
    wanted = [c.strip().strip('"') for c in columns.group(1).split(",")]
    entry = build_dumps.build("Python", SOURCES / "posts.jsonl", SOURCES / "comments.jsonl", tmp_path,
                              version="v1", log=lambda *_: None)
    for name in files.groups():
        assert name in entry["files"], f"dumps.js reads {name}, which the script doesn't build"
        path = tmp_path / entry["files"][name]["path"]
        got = [c for c, _ in schema(path)]
        assert all(c in got for c in wanted), f"{name} has {got}; dumps.js reads {wanted}"
        # dumps.js filters on the lowercase name, and relies on the file being sorted by it.
        assert entry["files"][name]["key"] == "author"
        authors = [r[got.index("author")] for r in in_file_order(path)]
        assert authors == sorted(authors) and all(a == a.lower() for a in authors)
