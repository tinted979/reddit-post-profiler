# /// script
# requires-python = ">=3.10"
# dependencies = ["duckdb>=1.1,<2"]
# ///
"""Build the web app's per-subreddit dump files from Arctic Shift JSONL dumps.

Reads one subreddit's posts and comments dumps (one JSON object per line) and writes
small Parquet files shaped for the two lookups the page makes, plus a manifest:

  posts_by_author.parquet     author (lowercase), created_utc; sorted by author, time
  comments_by_author.parquet  author (lowercase), created_utc; sorted by author, time
  comments_by_link.parquet    link_id (post id, no t3_), author (as written), created_utc;
                              sorted by link_id, time
  manifest.json               every subreddit built into this output directory

Only those columns are kept: no titles, bodies or other text. Deleted accounts and
AutoModerator are dropped (the page skips them anyway), rows are de-duplicated by id,
and rows from other subreddits are dropped with a warning.

Each build goes in its own directory, r/<subreddit>/<version>/, and is never
overwritten, so the files can be served with a long immutable cache time. The manifest
is the one file that changes: it points at each subreddit's current build.

Usage (from the repo root; uv installs DuckDB in a throwaway environment):

  uv run tools/build_dumps.py --subreddit Hasan_Piker \\
      --posts F:/r_Hasan_Piker_posts.jsonl --comments F:/r_Hasan_Piker_comments.jsonl

Add --memory-limit 4GB (any DuckDB size) to cap DuckDB's memory; past it DuckDB spills
to <out>/.tmp, which is removed when the build ends. See --help for --out, --version and
--row-group.

Then upload the output directory (default dumps/, which git ignores) as it is.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import shutil
import sys
import time
from pathlib import Path

import duckdb

# Bump when the files' columns, sort order or the manifest's shape change, so the page can
# refuse a manifest it doesn't understand.
FORMAT = 1
# Rows per Parquet row group. A lookup reads the file footer once, then only the row
# groups whose author (or link_id) range could hold the key, so smaller groups mean less
# to download per lookup; ~10k rows is ~100 KB here. DuckDB doesn't go below 2048.
DEFAULT_ROW_GROUP = 10_000
EXCLUDED = ("[deleted]", "[removed]", "automoderator")
SUBREDDIT_NAME = re.compile(r"^\w{2,21}$")
# One path segment that can't be "." or "..": it starts with a letter, digit or underscore.
VERSION_NAME = re.compile(r"^\w[\w.-]{0,39}$")


def utc_date(ts: int | None) -> str:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%d") if ts else "-"


def sql_str(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def load(con: duckdb.DuckDBPyConnection, table: str, path: Path, columns: dict[str, str], subreddit: str) -> dict:
    """Load the needed columns of a JSONL dump into `table`, cleaned. Returns counts.

    The dump is streamed twice: once for the counts, then straight into the cleaned
    table, so no raw copy of it is ever held."""
    cols = {**columns, "id": "VARCHAR", "author": "VARCHAR", "created_utc": "VARCHAR", "subreddit": "VARCHAR"}
    spec = "{" + ", ".join(f"{sql_str(k)}: {sql_str(v)}" for k, v in cols.items()) + "}"
    # ignore_errors skips malformed lines, such as a last line still being written.
    source = f"read_ndjson({sql_str(path.as_posix())}, columns = {spec}, ignore_errors = true)"
    raw, other_sub, unusable = con.execute(f"""
        SELECT count(*),
               count(*) FILTER (lower(subreddit) <> lower({sql_str(subreddit)})),
               count(*) FILTER (id IS NULL OR TRY_CAST(created_utc AS DOUBLE) IS NULL)
        FROM {source}
    """).fetchone()
    extra = ", ".join(columns)
    extra = f", {extra}" if extra else ""
    con.execute(f"""
        CREATE TEMP TABLE {table} AS
        SELECT id, author, CAST(CAST(created_utc AS DOUBLE) AS BIGINT) AS created_utc{extra}
        FROM {source}
        WHERE lower(subreddit) = lower({sql_str(subreddit)})
          AND id IS NOT NULL AND TRY_CAST(created_utc AS DOUBLE) IS NOT NULL
          AND author IS NOT NULL AND author <> ''
          AND lower(author) NOT IN ({", ".join(sql_str(a) for a in EXCLUDED)})
        QUALIFY row_number() OVER (PARTITION BY id ORDER BY created_utc) = 1
    """)
    kept, first, last = con.execute(f"SELECT count(*), min(created_utc), max(created_utc) FROM {table}").fetchone()
    return {"raw": raw, "other_subreddit": other_sub, "unusable": unusable, "kept": kept, "first": first, "last": last}


def write(con: duckdb.DuckDBPyConnection, query: str, path: Path, row_group: int) -> dict:
    con.execute(f"""
        COPY ({query}) TO {sql_str(path.as_posix())}
        (FORMAT parquet, COMPRESSION snappy, ROW_GROUP_SIZE {row_group})
    """)
    rows, groups = con.execute(f"""
        SELECT sum(num_rows), count(*) FROM (
          SELECT DISTINCT row_group_id, row_group_num_rows AS num_rows
          FROM parquet_metadata({sql_str(path.as_posix())}))
    """).fetchone()
    return {"bytes": path.stat().st_size, "rows": int(rows or 0), "row_groups": int(groups)}


def check_sorted(con: duckdb.DuckDBPyConnection, path: Path, key: str) -> None:
    """Fail unless each row group's key range starts at or after the previous one's end,
    which is what lets a reader skip to the one group that can hold a key."""
    ranges = con.execute(f"""
        SELECT stats_min_value, stats_max_value FROM parquet_metadata({sql_str(path.as_posix())})
        WHERE path_in_schema = {sql_str(key)} ORDER BY row_group_id
    """).fetchall()
    for (_, prev_max), (next_min, _) in zip(ranges, ranges[1:]):
        if prev_max is None or next_min is None or next_min < prev_max:
            raise SystemExit(f"{path.name}: row groups aren't in {key} order ({prev_max!r} then {next_min!r})")


def temp_dir(out: Path) -> Path:
    """Where DuckDB spills: inside the output directory, never the current one, and
    outside r/, so the upload (r/**/*.parquet and manifest.json) never picks it up."""
    return out / ".tmp"


def connect(out: Path, memory_limit: str | None = None) -> duckdb.DuckDBPyConnection:
    """An in-memory DuckDB that spills under `out`, doesn't keep insertion order (every
    COPY has its own ORDER BY) and, if given, keeps to `memory_limit` (e.g. "4GB")."""
    config = {"temp_directory": temp_dir(out).as_posix(), "preserve_insertion_order": False}
    if memory_limit:
        config["memory_limit"] = memory_limit
    return duckdb.connect(config=config)


def build(subreddit: str, posts: Path, comments: Path, out: Path, version: str | None = None,
          row_group: int = DEFAULT_ROW_GROUP, now: float | None = None, log=print,
          memory_limit: str | None = None) -> dict:
    if not SUBREDDIT_NAME.match(subreddit):
        raise SystemExit(f"not a subreddit name: {subreddit!r}")
    for path in (posts, comments):
        if not path.is_file():
            raise SystemExit(f"no such file: {path}")
    started = time.time()
    con = connect(out, memory_limit)
    try:
        return _build(con, subreddit, posts, comments, out, version, row_group, now, log, started)
    finally:
        con.close()
        shutil.rmtree(temp_dir(out), ignore_errors=True)


def _build(con: duckdb.DuckDBPyConnection, subreddit: str, posts: Path, comments: Path, out: Path,
           version: str | None, row_group: int, now: float | None, log, started: float) -> dict:
    p = load(con, "posts", posts, {}, subreddit)
    c = load(con, "comments", comments, {"link_id": "VARCHAR"}, subreddit)
    for kind, n in (("posts", p), ("comments", c)):
        log(f"{kind}: {n['raw']:,} read, {n['kept']:,} kept, {utc_date(n['first'])} to {utc_date(n['last'])}")
        if n["other_subreddit"]:
            log(f"  warning: dropped {n['other_subreddit']:,} rows from other subreddits")
        if n["unusable"]:
            log(f"  warning: dropped {n['unusable']:,} rows with no id or time")
        if not n["kept"]:
            raise SystemExit(f"no {kind} left for r/{subreddit}: is it the right file?")

    # A build is named after the day its data runs to, so rebuilding from a newer dump
    # gets a new directory and the old files stay valid while the manifest moves over.
    version = version or utc_date(min(p["last"], c["last"]))
    if not VERSION_NAME.match(version):
        raise SystemExit(f"not a usable version name: {version!r}")
    key = subreddit.lower()
    rel = Path("r") / key / version
    target = out / rel
    if target.exists():
        raise SystemExit(f"{target} already exists; builds are never overwritten (pass --version to name a new one)")
    target.mkdir(parents=True)

    files = {}
    specs = {
        "posts_by_author": ("SELECT lower(author) AS author, created_utc FROM posts ORDER BY author, created_utc",
                            "author", p),
        "comments_by_author": ("SELECT lower(author) AS author, created_utc FROM comments ORDER BY author, created_utc",
                               "author", c),
        "comments_by_link": ("""SELECT regexp_replace(link_id, '^t3_', '') AS link_id, author, created_utc
                                FROM comments WHERE link_id IS NOT NULL ORDER BY link_id, created_utc""",
                             "link_id", c),
    }
    for name, (query, sort_key, counts) in specs.items():
        path = target / f"{name}.parquet"
        info = write(con, query, path, row_group)
        check_sorted(con, path, sort_key)
        files[name] = {
            "path": (rel / path.name).as_posix(),
            **info,
            "key": sort_key,
            "from_utc": counts["first"],
            "to_utc": counts["last"],
        }
        log(f"{name}: {info['rows']:,} rows in {info['row_groups']} row groups, {info['bytes'] / 1e6:.1f} MB")

    manifest_path = out / "manifest.json"
    manifest = {"format": FORMAT, "subreddits": {}}
    if manifest_path.exists():
        existing = json.loads(manifest_path.read_text(encoding="utf-8"))
        if existing.get("format") != FORMAT:
            raise SystemExit(f"{manifest_path} has format {existing.get('format')}, this script writes {FORMAT}")
        manifest = existing
    entry = {
        "name": subreddit,
        "version": version,
        "built_utc": int(now if now is not None else time.time()),
        # Posts and comments up to here are in the files; anything later needs the API.
        "posts_to_utc": p["last"],
        "comments_to_utc": c["last"],
        "files": files,
    }
    manifest["subreddits"][key] = entry
    manifest["subreddits"] = dict(sorted(manifest["subreddits"].items()))
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    log(f"wrote {target} and {manifest_path} in {time.time() - started:.0f} s")
    return entry


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--subreddit", required=True, help="subreddit name, as on Reddit (e.g. Hasan_Piker)")
    parser.add_argument("--posts", required=True, type=Path, help="the subreddit's posts dump (.jsonl)")
    parser.add_argument("--comments", required=True, type=Path, help="the subreddit's comments dump (.jsonl)")
    parser.add_argument("--out", type=Path, default=Path("dumps"), help="output directory (default: dumps)")
    parser.add_argument("--version", help="build directory name (default: the date the data runs to)")
    parser.add_argument("--row-group", type=int, default=DEFAULT_ROW_GROUP,
                        help=f"rows per Parquet row group (default: {DEFAULT_ROW_GROUP})")
    parser.add_argument("--memory-limit",
                        help="DuckDB's memory limit, e.g. 4GB (default: DuckDB's own, 80%% of RAM)")
    args = parser.parse_args(argv)
    build(args.subreddit, args.posts, args.comments, args.out, args.version, args.row_group,
          memory_limit=args.memory_limit)


if __name__ == "__main__":
    sys.exit(main())
