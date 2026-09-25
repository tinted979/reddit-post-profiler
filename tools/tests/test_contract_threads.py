"""The contract for the thread file: what web/dumps.js's threadRows reads from
comments_by_link must be what tools/build_dumps.py writes (see test_contract.py for the
by-author files).

Run from the repo root:  uv run --with duckdb --with pytest pytest tools
"""

import re
import sys
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_dumps  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ROOT / "web" / "tests" / "fixtures" / "dumps-src"
DUMPS_JS = (ROOT / "web" / "dumps.js").read_text(encoding="utf-8")


def test_the_page_reads_the_thread_file_the_script_writes(tmp_path):
    name = re.search(r'const LINK_FILE = "(\w+)";', DUMPS_JS)
    columns = re.search(r'columns: \[("link_id"[^\]]*)\]', DUMPS_JS)
    assert name and columns, "LINK_FILE or threadRows' parquetQuery columns not found in web/dumps.js"
    wanted = [c.strip().strip('"') for c in columns.group(1).split(",")]
    entry = build_dumps.build("Python", SOURCES / "posts.jsonl", SOURCES / "comments.jsonl", tmp_path,
                              version="v1", log=lambda *_: None)
    f = entry["files"].get(name.group(1))
    assert f, f"dumps.js reads {name.group(1)}, which the script doesn't build"
    path = (tmp_path / f["path"]).as_posix()
    got = [c[0] for c in duckdb.sql(f"DESCRIBE SELECT * FROM '{path}'").fetchall()]
    assert all(c in got for c in wanted), f"{name.group(1)} has {got}; dumps.js reads {wanted}"
    # threadRows filters on the post id as the page has it (no t3_ prefix), and relies on
    # the file being sorted by it.
    assert f["key"] == "link_id"
    links = [r[0] for r in duckdb.sql(f"SELECT link_id FROM '{path}'").fetchall()]
    assert links == sorted(links) and not any(link.startswith("t3_") for link in links)
