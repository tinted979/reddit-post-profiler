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

To bring a build up to date with rows fetched since (tools/fetch_subreddit.mjs, for the
archive sync, docs/adr/0005), splice them onto it:

  uv run tools/build_dumps.py --subreddit Hasan_Piker \
      --posts new_posts.jsonl --comments new_comments.jsonl --splice live --cut 1790000000 \
      --posts-through 1790100000 --comments-through 1790100000 --out live

live/ is laid out like the archive: its manifest.json, and the subreddit's current build under
r/<key>/<version>/. The new build keeps that build's rows up to --cut and adds the fetched rows
after it, cleaned the same way; the two can't overlap, so no ids are needed. It's complete up
to --posts-through and --comments-through (the fetcher's complete_through), which become its
cutoffs, and it's named after when it was built (YYYY-MM-DDTHHMMSSZ). The cut can't be after
the live build's cutoffs (what's between would be in neither), and the new cutoffs can't be
earlier than them. --posts-through/--comments-through also work without --splice, for a first
build fetched from the API: rows after them are left out.
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


def utc_time(ts: int) -> str:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def sql_str(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def load(con: duckdb.DuckDBPyConnection, table: str, path: Path, columns: dict[str, str], subreddit: str,
         after: int | None = None, upto: int | None = None) -> dict:
    """Load the needed columns of a JSONL dump into `table`, cleaned. Returns counts.

    Only rows after `after` and up to `upto` (epoch seconds; None for no bound) are kept.
    The dump is streamed twice: once for the counts, then straight into the cleaned
    table, so no raw copy of it is ever held."""
    cols = {**columns, "id": "VARCHAR", "author": "VARCHAR", "created_utc": "VARCHAR", "subreddit": "VARCHAR"}
    spec = "{" + ", ".join(f"{sql_str(k)}: {sql_str(v)}" for k, v in cols.items()) + "}"
    # ignore_errors skips malformed lines, such as a last line still being written.
    source = f"read_ndjson({sql_str(path.as_posix())}, columns = {spec}, ignore_errors = true)"
    ts = "CAST(TRY_CAST(created_utc AS DOUBLE) AS BIGINT)"
    bounds = ([f"{ts} > {int(after)}"] if after is not None else []) + ([f"{ts} <= {int(upto)}"] if upto is not None else [])
    window = "".join(f" AND {b}" for b in bounds)
    raw, other_sub, unusable, outside = con.execute(f"""
        SELECT count(*),
               count(*) FILTER (lower(subreddit) <> lower({sql_str(subreddit)})),
               count(*) FILTER (id IS NULL OR TRY_CAST(created_utc AS DOUBLE) IS NULL),
               count(*) FILTER ({ts} IS NOT NULL AND NOT ({" AND ".join(bounds) or "TRUE"}))
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
          AND lower(author) NOT IN ({", ".join(sql_str(a) for a in EXCLUDED)}){window}
        QUALIFY row_number() OVER (PARTITION BY id ORDER BY created_utc) = 1
    """)
    kept, first, last = con.execute(f"SELECT count(*), min(created_utc), max(created_utc) FROM {table}").fetchone()
    return {"raw": raw, "other_subreddit": other_sub, "unusable": unusable, "outside": outside,
            "kept": kept, "first": first, "last": last}


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
          memory_limit: str | None = None, splice: Path | None = None, cut: int | None = None,
          posts_through: int | None = None, comments_through: int | None = None) -> dict:
    if not SUBREDDIT_NAME.match(subreddit):
        raise SystemExit(f"not a subreddit name: {subreddit!r}")
    for path in (posts, comments):
        if not path.is_file():
            raise SystemExit(f"no such file: {path}")
    if splice is None and cut is not None:
        raise SystemExit("--cut needs --splice: it's where the live build's rows give way to the fetched ones")
    if splice is not None and None in (cut, posts_through, comments_through):
        raise SystemExit("a splice needs --cut, --posts-through and --comments-through")
    built = int(now if now is not None else time.time())
    # These go into SQL, so they're whole numbers whoever passed them.
    cut = None if cut is None else int(cut)
    through = {kind: None if t is None else int(t) for kind, t in (("posts", posts_through), ("comments", comments_through))}
    for kind, t in through.items():
        if t is not None and t > built:
            raise SystemExit(f"--{kind}-through {utc_time(t)} is in the future: the files can't be complete up to it")
    started = time.time()
    con = connect(out, memory_limit)
    try:
        return _build(con, subreddit, posts, comments, out, version, row_group, built, log, started, splice, cut, through)
    finally:
        con.close()
        shutil.rmtree(temp_dir(out), ignore_errors=True)


def _build(con: duckdb.DuckDBPyConnection, subreddit: str, posts: Path, comments: Path, out: Path,
           version: str | None, row_group: int, built: int, log, started: float,
           splice: Path | None, cut: int | None, through: dict) -> dict:
    key = subreddit.lower()
    if splice is None:
        specs, cutoffs, default_version = from_jsonl(con, subreddit, posts, comments, through, log)
    else:
        specs, cutoffs = spliced(con, subreddit, posts, comments, live_build(con, splice, key), cut, through, log)
        # Synced builds come several a day, so they're named after the moment they're built.
        default_version = dt.datetime.fromtimestamp(built, dt.timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")
    version = version or default_version
    if not VERSION_NAME.match(version):
        raise SystemExit(f"not a usable version name: {version!r}")
    rel = Path("r") / key / version
    target = out / rel
    if target.exists():
        raise SystemExit(f"{target} already exists; builds are never overwritten (pass --version to name a new one)")
    target.mkdir(parents=True)

    files = {}
    for name, (query, sort_key, (first, last)) in specs.items():
        path = target / f"{name}.parquet"
        info = write(con, query, path, row_group)
        check_sorted(con, path, sort_key)
        files[name] = {
            "path": (rel / path.name).as_posix(),
            **info,
            "key": sort_key,
            "from_utc": first,
            "to_utc": last,
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
        "built_utc": built,
        # Posts and comments up to here are in the files; anything later needs the API.
        "posts_to_utc": cutoffs["posts"],
        "comments_to_utc": cutoffs["comments"],
        "files": files,
    }
    manifest["subreddits"][key] = entry
    manifest["subreddits"] = dict(sorted(manifest["subreddits"].items()))
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    log(f"wrote {target} and {manifest_path} in {time.time() - started:.0f} s")
    return entry


def warn(log, kind: str, n: dict, window: str) -> None:
    if n["other_subreddit"]:
        log(f"  warning: dropped {n['other_subreddit']:,} rows from other subreddits")
    if n["unusable"]:
        log(f"  warning: dropped {n['unusable']:,} rows with no id or time")
    if n["outside"]:
        log(f"  dropped {n['outside']:,} {kind} {window}")


def from_jsonl(con: duckdb.DuckDBPyConnection, subreddit: str, posts: Path, comments: Path, through: dict, log):
    """A build from JSONL alone: (the three files' queries, sort keys and time spans; the
    cutoffs; the default version)."""
    p = load(con, "posts", posts, {}, subreddit, upto=through["posts"])
    c = load(con, "comments", comments, {"link_id": "VARCHAR"}, subreddit, upto=through["comments"])
    for kind, n in (("posts", p), ("comments", c)):
        log(f"{kind}: {n['raw']:,} read, {n['kept']:,} kept, {utc_date(n['first'])} to {utc_date(n['last'])}")
        warn(log, kind, n, f"after --{kind}-through")
        if not n["kept"]:
            raise SystemExit(f"no {kind} left for r/{subreddit}: is it the right file?")
    specs = {
        "posts_by_author": ("SELECT lower(author) AS author, created_utc FROM posts ORDER BY author, created_utc",
                            "author", (p["first"], p["last"])),
        "comments_by_author": ("SELECT lower(author) AS author, created_utc FROM comments ORDER BY author, created_utc",
                               "author", (c["first"], c["last"])),
        "comments_by_link": ("""SELECT regexp_replace(link_id, '^t3_', '') AS link_id, author, created_utc
                                FROM comments WHERE link_id IS NOT NULL ORDER BY link_id, created_utc""",
                             "link_id", (c["first"], c["last"])),
    }
    # Without a known cutoff, the files run to their newest row.
    cutoffs = {kind: through[kind] if through[kind] is not None else n["last"] for kind, n in (("posts", p), ("comments", c))}
    # A build is named after the day its data runs to, so rebuilding from a newer dump
    # gets a new directory and the old files stay valid while the manifest moves over.
    return specs, cutoffs, utc_date(min(p["last"], c["last"]))


# The files of a build, and their columns in order.
COLUMNS = {
    "posts_by_author": ["author", "created_utc"],
    "comments_by_author": ["author", "created_utc"],
    "comments_by_link": ["link_id", "author", "created_utc"],
}


def live_build(con: duckdb.DuckDBPyConnection, source: Path, key: str) -> dict:
    """The subreddit's build in `source`, laid out like the archive (manifest.json, and the
    files under r/<key>/<version>/): {version, posts_to_utc, comments_to_utc, files: {name:
    path}}. It was downloaded, so it's checked like any untrusted input before anything is
    spliced onto it: the paths are rebuilt from the key and version rather than followed."""
    path = source / "manifest.json"
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        raise SystemExit(f"can't read {path}: {err}")
    fmt = manifest.get("format") if isinstance(manifest, dict) else None
    if fmt != FORMAT:
        raise SystemExit(f"{path} has format {fmt}, this script writes {FORMAT}")
    subs = manifest.get("subreddits")
    entry = subs.get(key) if isinstance(subs, dict) else None
    if not isinstance(entry, dict):
        raise SystemExit(f"r/{key} isn't in {path}: there's no build to splice onto")
    version = entry.get("version")
    if not isinstance(version, str) or not VERSION_NAME.match(version):
        raise SystemExit(f"{path}: not a usable version name: {version!r}")
    found = {"version": version, "files": {}}
    for field in ("posts_to_utc", "comments_to_utc"):
        value = entry.get(field)
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise SystemExit(f"{path}: r/{key} has no usable {field}")
        found[field] = value
    listed = entry.get("files") if isinstance(entry.get("files"), dict) else {}
    for name, columns in COLUMNS.items():
        rel = f"r/{key}/{version}/{name}.parquet"
        f = listed.get(name)
        if not isinstance(f, dict) or f.get("path") != rel:
            raise SystemExit(f"{path}: r/{key}'s {name} isn't at {rel}")
        local = source / rel
        if not local.is_file():
            raise SystemExit(f"no such file: {local} (download the live build first)")
        if local.stat().st_size != f.get("bytes"):
            raise SystemExit(f"{local} is {local.stat().st_size} bytes, but the manifest says {f.get('bytes')}: "
                             "download the live build again")
        try:
            got = [c[0] for c in con.execute(f"DESCRIBE SELECT * FROM read_parquet({sql_str(local.as_posix())})").fetchall()]
        except duckdb.Error as err:
            raise SystemExit(f"can't read {local}: {err}")
        if got != columns:
            raise SystemExit(f"{local} has columns {got}, not {columns}")
        found["files"][name] = local
    return found


def spliced(con: duckdb.DuckDBPyConnection, subreddit: str, posts: Path, comments: Path, live: dict, cut: int,
            through: dict, log):
    """A splice: the live build's rows up to `cut`, and the fetched rows after it up to each
    kind's `through`. Returns (the three files' queries, sort keys and time spans; the cutoffs)."""
    for kind in ("posts", "comments"):
        was = live[f"{kind}_to_utc"]
        if cut > was:
            raise SystemExit(f"--cut {utc_time(cut)} is after the live build's {kind} cutoff, {utc_time(was)}: "
                             "what's between would be in neither")
        if through[kind] < was:
            raise SystemExit(f"--{kind}-through {utc_time(through[kind])} is earlier than the live build's {kind} "
                             f"cutoff, {utc_time(was)}: the new build would cover less (fetch further, or keep the live one)")
    p = load(con, "posts", posts, {}, subreddit, after=cut, upto=through["posts"])
    c = load(con, "comments", comments, {"link_id": "VARCHAR"}, subreddit, after=cut, upto=through["comments"])
    old = {name: f"read_parquet({sql_str(path.as_posix())})" for name, path in live["files"].items()}
    # The live files' rows and the fetched ones meet at the cut, so none is in both.
    con.execute(f"""CREATE TEMP TABLE posts_by_author AS
        SELECT author, created_utc FROM {old['posts_by_author']} WHERE created_utc <= {cut}
        UNION ALL SELECT lower(author), created_utc FROM posts""")
    con.execute(f"""CREATE TEMP TABLE comments_by_author AS
        SELECT author, created_utc FROM {old['comments_by_author']} WHERE created_utc <= {cut}
        UNION ALL SELECT lower(author), created_utc FROM comments""")
    con.execute(f"""CREATE TEMP TABLE comments_by_link AS
        SELECT link_id, author, created_utc FROM {old['comments_by_link']} WHERE created_utc <= {cut}
        UNION ALL SELECT regexp_replace(link_id, '^t3_', ''), author, created_utc FROM comments WHERE link_id IS NOT NULL""")
    spans = {}
    for kind, n, table in (("posts", p, "posts_by_author"), ("comments", c, "comments_by_author")):
        total, first, last = con.execute(f"SELECT count(*), min(created_utc), max(created_utc) FROM {table}").fetchone()
        log(f"{kind}: {total - n['kept']:,} kept from {live['version']} up to {utc_time(cut)}; "
            f"{n['raw']:,} fetched rows read, {n['kept']:,} added, complete up to {utc_time(through[kind])}")
        warn(log, kind, n, "outside the cut and the cutoff")
        if not total:
            raise SystemExit(f"no {kind} left for r/{subreddit} after the splice")
        spans[kind] = (first, last)
    specs = {
        "posts_by_author": ("SELECT * FROM posts_by_author ORDER BY author, created_utc", "author", spans["posts"]),
        "comments_by_author": ("SELECT * FROM comments_by_author ORDER BY author, created_utc", "author", spans["comments"]),
        "comments_by_link": ("SELECT * FROM comments_by_link ORDER BY link_id, created_utc", "link_id", spans["comments"]),
    }
    return specs, dict(through)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--subreddit", required=True, help="subreddit name, as on Reddit (e.g. Hasan_Piker)")
    parser.add_argument("--posts", required=True, type=Path, help="the subreddit's posts dump (.jsonl)")
    parser.add_argument("--comments", required=True, type=Path, help="the subreddit's comments dump (.jsonl)")
    parser.add_argument("--out", type=Path, default=Path("dumps"), help="output directory (default: dumps)")
    parser.add_argument("--version",
                        help="build directory name (default: the date the data runs to; for a splice, when it's built)")
    parser.add_argument("--row-group", type=int, default=DEFAULT_ROW_GROUP,
                        help=f"rows per Parquet row group (default: {DEFAULT_ROW_GROUP})")
    parser.add_argument("--memory-limit",
                        help="DuckDB's memory limit, e.g. 4GB (default: DuckDB's own, 80%% of RAM)")
    parser.add_argument("--splice", type=Path, metavar="DIR",
                        help="splice onto the subreddit's build in DIR, laid out like the archive (manifest.json "
                             "and r/<key>/<version>/): keep its rows up to --cut, and add --posts/--comments after it")
    parser.add_argument("--cut", type=int, metavar="EPOCH",
                        help="with --splice: where the live build's rows give way to the fetched ones")
    parser.add_argument("--posts-through", type=int, metavar="EPOCH",
                        help="posts are complete up to here: the manifest's cutoff (default: the newest post; "
                             "needed with --splice)")
    parser.add_argument("--comments-through", type=int, metavar="EPOCH",
                        help="comments are complete up to here (as --posts-through)")
    args = parser.parse_args(argv)
    build(args.subreddit, args.posts, args.comments, args.out, args.version, args.row_group,
          memory_limit=args.memory_limit, splice=args.splice, cut=args.cut,
          posts_through=args.posts_through, comments_through=args.comments_through)


if __name__ == "__main__":
    sys.exit(main())
