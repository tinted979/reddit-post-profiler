# /// script
# requires-python = ">=3.10"
# dependencies = ["duckdb>=1.1,<2"]
# ///
"""The archive sync's build job (docs/adr/0005): bring the subreddits in tools/archive.json up
to date, and leave bundles for tools/publish_build.sh. It needs no token.

  uv run tools/archive_sync.py plan  [--config tools/archive.json]
  uv run tools/archive_sync.py build --out DIR [--config ...] [--only NAME] [--repair NAME] [--budget PAGES]

`plan` says which subreddits are due, and why. `build` does the same, then, for each in turn:
  1. downloads its live build through the public URL (and, past the edge cache, the live
     manifest and its publish log);
  2. fetches its posts and comments since the cut with tools/fetch_subreddit.mjs;
  3. splices them onto the live build (build_dumps.py --splice) ...
  4. ... and makes DIR/bundles/NN-<key>/ with `check_upload.py merge-one`.
Several bundles publish in turn: each is merged onto the manifest the one before will leave
live, so publish_build.sh accepts it only once that one is up. A server that's busy or
rate-limiting stops the fetching, keeping the bundles made so far (docs/adr/0002); a subreddit
whose fetch, splice or merge fails is skipped. DIR/summary.json says what happened.

A subreddit is due:
  - to sync, once its cadence has passed since its live build (less SLACK, for cron's jitter):
    from its older cutoff less `overlap`;
  - to repair, once `repair_every` has passed since its last repair (marked in its publish log;
    before any, since its first publish, or its build): from `repair_days` before its older
    cutoff, so items Arctic Shift archived late come in. Only a subreddit that's caught up
    (its cutoff within CAUGHT_UP of now) repairs; one still catching up syncs;
  - for a first build from its start, when it isn't live yet and its config says
    "backfill": "api". Otherwise it's skipped: import it instead (build_dumps.py from the
    download tool's JSONL, then upload_dumps.sh).
Caught-up subreddits go first, most overdue first, then those catching up, then first builds.
--only NAME builds just that one, due or not; --repair NAME repairs just that one.

tools/archive.json: {"subreddits": {"<Name>": {"cadence": "1h"[, "backfill": "api"]}},
"overlap": "2h", "repair_days": 7, "repair_every": "7d", "budget": <pages per fetch>,
"run_budget": <pages per run, every fetch together>}. Durations are a number and m, h or d;
cadences run from 1h to 7d. Once a run's pages are spent, the subreddits left wait for the next.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_dumps  # noqa: E402
import check_upload  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "tools" / "archive.json"
PUBLIC = os.environ.get("DUMPS_URL", "https://rpp-db.tinted979.dev")
FETCHER = ["node", str(ROOT / "tools" / "fetch_subreddit.mjs")]
USER_AGENT = "reddit-post-profiler-archive (+https://github.com/tinted979/reddit-post-profiler)"
MINUTE, HOUR, DAY = 60, 3600, 86400
DURATION = re.compile(r"^(\d{1,4})([mhd])$")
UNITS = {"m": MINUTE, "h": HOUR, "d": DAY}
# Scheduled runs start a little late or early, so a subreddit is due this much before its time.
SLACK = 15 * MINUTE
# A subreddit whose cutoff is within this of now is caught up, and can be repaired.
CAUGHT_UP = DAY
# The fetcher's: rows have had this long to be archived before a fetch calls them complete.
SETTLE = MINUTE
MAX_BUDGET = 10_000
MAX_RUN_BUDGET = 50_000
# A download bigger than this isn't one of the archive's files.
MAX_DOWNLOAD = 512 * 1024 * 1024


class Skip(Exception):
    """A subreddit this run can't build; the message says why."""


def duration(value, what: str, lo: int, hi: int) -> int:
    m = DURATION.match(value) if isinstance(value, str) else None
    seconds = int(m.group(1)) * UNITS[m.group(2)] if m else None
    if seconds is None or not lo <= seconds <= hi:
        raise SystemExit(f"archive config: {what} must be a duration like 2h or 7d, from {lo // MINUTE} minutes "
                         f"to {hi // DAY} days: {value!r}")
    return seconds


def whole(value, what: str, lo: int, hi: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not lo <= value <= hi:
        raise SystemExit(f"archive config: {what} must be a whole number from {lo} to {hi}: {value!r}")
    return value


def parse_config(raw) -> dict:
    """tools/archive.json, checked: {subreddits: {key: {name, cadence, backfill}}, overlap,
    repair_days, repair_every, budget, run_budget}, with durations in seconds."""
    if not isinstance(raw, dict):
        raise SystemExit("archive config: not a JSON object")
    unknown = set(raw) - {"subreddits", "overlap", "repair_days", "repair_every", "budget", "run_budget"}
    if unknown:
        raise SystemExit(f"archive config: unknown setting {', '.join(sorted(unknown))}")
    listed = raw.get("subreddits")
    if not isinstance(listed, dict) or not listed:
        raise SystemExit("archive config: no subreddits")
    subs = {}
    for name, opts in listed.items():
        if not isinstance(name, str) or not build_dumps.SUBREDDIT_NAME.match(name):
            raise SystemExit(f"archive config: not a subreddit name: {name!r}")
        key = name.lower()
        if key in subs:
            raise SystemExit(f"archive config: r/{name} is listed twice")
        if not isinstance(opts, dict):
            raise SystemExit(f"archive config: r/{name} needs its settings, like {{\"cadence\": \"1h\"}}")
        unknown = set(opts) - {"cadence", "backfill"}
        if unknown:
            raise SystemExit(f"archive config: r/{name}: unknown setting {', '.join(sorted(unknown))}")
        if opts.get("backfill") not in (None, "api"):
            raise SystemExit(f"archive config: r/{name}: backfill can only be \"api\"")
        subs[key] = {"name": name, "cadence": duration(opts.get("cadence"), f"r/{name}'s cadence", HOUR, 7 * DAY),
                     "backfill": opts.get("backfill") == "api"}
    return {
        "subreddits": subs,
        "overlap": duration(raw.get("overlap"), "overlap", 10 * MINUTE, DAY),
        "repair_days": whole(raw.get("repair_days"), "repair_days", 1, 30),
        "repair_every": duration(raw.get("repair_every"), "repair_every", DAY, 30 * DAY),
        "budget": whole(raw.get("budget"), "budget (pages per fetch)", 1, MAX_BUDGET),
        # At least a page of each kind.
        "run_budget": whole(raw.get("run_budget"), "run_budget (pages per run)", 2, MAX_RUN_BUDGET),
    }


def ago(seconds: int) -> str:
    return f"{seconds // DAY} d" if seconds >= 2 * DAY else f"{seconds // HOUR} h" if seconds >= 2 * HOUR else f"{seconds // MINUTE} min"


def utc(ts: int | None) -> str:
    return "the start" if ts is None else time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(ts))


def plan(config: dict, manifest, logs: dict, now: int, only: str | None = None, repair: str | None = None):
    """(the due subreddits in order, as {name, key, mode, cut}; why each other one isn't).
    `logs` maps a key to its publish log, as downloaded (absent: none yet)."""
    subs = config["subreddits"]
    if only is not None and repair is not None and only.lower() != repair.lower():
        raise SystemExit(f"--only {only} and --repair {repair} name different subreddits")
    target = only or repair
    if target is not None and target.lower() not in subs:
        raise SystemExit(f"r/{target} isn't in the config")
    live = manifest.get("subreddits") if isinstance(manifest, dict) else None
    live = live if isinstance(live, dict) else {}
    dues, skipped = [], []
    for key, sub in subs.items():
        name = sub["name"]
        if target is not None and key != target.lower():
            continue
        log = logs.get(key)
        problem = check_upload.log_problem(log, key) if log is not None else None
        if problem:
            skipped.append(f"r/{name}: its publish log {problem}: fix or remove it by hand")
            continue
        entry = live.get(key)
        if not isinstance(entry, dict):
            if sub["backfill"]:
                dues.append({"name": name, "key": key, "mode": "first", "cut": None, "rank": 2, "overdue": 0})
            else:
                skipped.append(f"r/{name} isn't in the archive yet: import it (build_dumps.py from the download tool's "
                               "JSONL, then upload_dumps.sh), or set \"backfill\": \"api\" in tools/archive.json")
            continue
        built, *cutoffs = (entry.get(f) for f in ("built_utc", "posts_to_utc", "comments_to_utc"))
        if not all(check_upload.is_time(v) for v in (built, *cutoffs)):
            skipped.append(f"r/{name}: the live manifest's entry has no usable times")
            continue
        cutoff = min(cutoffs)
        caught_up = now - cutoff <= CAUGHT_UP
        publishes = log["publishes"] if log is not None else []
        repairs = [e["utc"] for e in publishes if e.get("repair")]
        last_repair = max(repairs) if repairs else publishes[0]["utc"] if publishes else built
        if repair is not None or (caught_up and now - last_repair >= config["repair_every"] - SLACK):
            mode, cut = "repair", cutoff - config["repair_days"] * DAY
        elif only is not None or now - built >= sub["cadence"] - SLACK:
            mode, cut = "sync", cutoff - config["overlap"]
        else:
            skipped.append(f"r/{name}: not due (built {ago(now - built)} ago; every {ago(sub['cadence'])})")
            continue
        dues.append({"name": name, "key": key, "mode": mode, "cut": cut, "rank": 0 if caught_up else 1,
                     "overdue": now - built - sub["cadence"]})
    dues.sort(key=lambda d: (d["rank"], -d["overdue"]))
    return [{k: d[k] for k in ("name", "key", "mode", "cut")} for d in dues], skipped


def http_get(url: str) -> tuple[int, bytes]:
    """(HTTP status, body); status 0 when there was no answer."""
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=120) as resp:
            body = resp.read(MAX_DOWNLOAD + 1)
            if len(body) > MAX_DOWNLOAD:
                raise SystemExit(f"{url}: more than {MAX_DOWNLOAD} bytes, which no archive file is")
            return resp.status, body
    except urllib.error.HTTPError as err:
        return err.code, b""
    except (urllib.error.URLError, OSError):
        return 0, b""


def read_live(get, public: str, keys, now: int):
    """The live manifest's bytes and parsed form, and each key's publish log (bytes, or None if
    there's none), past the edge cache."""
    status, live_bytes = get(f"{public}/manifest.json?check={now}")
    if status != 200:
        raise SystemExit(f"couldn't read the live manifest (HTTP {status})")
    try:
        manifest = json.loads(live_bytes)
    except ValueError:
        raise SystemExit("the live manifest isn't JSON")
    logs = {}
    for key in keys:
        status, body = get(f"{public}/r/{key}/published.json?check={now}")
        if status == 200:
            logs[key] = body
        elif status != 404:
            raise SystemExit(f"couldn't read r/{key}/published.json (HTTP {status})")
    return live_bytes, manifest, logs


def parse_logs(raw: dict) -> dict:
    parsed = {}
    for key, body in raw.items():
        try:
            parsed[key] = json.loads(body)
        except ValueError:
            parsed[key] = "not JSON"  # plan() reports it
    return parsed


def download_build(get, public: str, entry: dict, key: str, archive: Path) -> None:
    """The live build's files, into archive/r/<key>/<version>/, where the splice reads them
    (build_dumps.py checks them against the manifest)."""
    version = entry.get("version")
    if not isinstance(version, str) or not check_upload.VERSION_NAME.match(version):
        raise Skip(f"r/{entry.get('name', key)}: the live manifest's version isn't usable: {version!r}")
    for name in check_upload.BUILD_FILES:
        rel = f"r/{key}/{version}/{name}.parquet"
        status, body = get(f"{public}/{rel}")
        if status != 200:
            raise Skip(f"r/{entry.get('name', key)}: couldn't download {rel} (HTTP {status})")
        (archive / rel).parent.mkdir(parents=True, exist_ok=True)
        (archive / rel).write_bytes(body)


def fetch(fetch_cmd: list[str], name: str, kind: str, after: int | None, before: int, budget: int, where: Path) -> dict:
    """Run the fetcher for one kind; its result (the rows are in where/<kind>.jsonl)."""
    where.mkdir(parents=True, exist_ok=True)
    rows, result = where / f"{kind}.jsonl", where / f"{kind}.json"
    args = ["--subreddit", name, "--kind", kind, "--before", str(before), "--budget", str(budget),
            "--out", str(rows), "--result", str(result)]
    if after is not None:
        args += ["--after", str(after)]
    done = subprocess.run([*fetch_cmd, *args], cwd=ROOT)
    if done.returncode not in (0, 3) or not result.is_file():
        raise Skip(f"r/{name}: the {kind} fetch failed (exit {done.returncode})")
    return json.loads(result.read_text(encoding="utf-8"))


def merge(name: str, key: str, archive: Path, live: Path, log: Path, bundle: Path, now: int, repair: bool) -> None:
    """check_upload.py merge-one, with its refusals raised as Skip."""
    args = ["merge-one", "--key", key, "--dumps", str(archive), "--live", str(live), "--log", str(log), "--out", str(bundle)]
    errors = io.StringIO()
    try:
        with contextlib.redirect_stderr(errors):
            check_upload.main(args + (["--repair"] if repair else []), now=now)
    except SystemExit as err:
        print(errors.getvalue(), end="", file=sys.stderr)
        raise Skip(f"r/{name}: {errors.getvalue().strip().replace(chr(10), '; ') or err}")


def build(config: dict, out: Path, now: int, get, fetch_cmd: list[str], public: str, only: str | None = None,
          repair: str | None = None, budget: int | None = None, log=print) -> dict:
    """Make out/bundles/NN-<key>/ for each due subreddit (see the top of this file). Returns the
    summary it also writes to out/summary.json."""
    if out.exists():
        raise SystemExit(f"{out} already exists: a build starts afresh")
    archive = out / "archive"
    archive.mkdir(parents=True)
    live_bytes, manifest, raw_logs = read_live(get, public, config["subreddits"], now)
    (out / "live-manifest.json").write_bytes(live_bytes)
    (archive / "manifest.json").write_bytes(live_bytes)
    (out / "logs").mkdir()
    for key, body in raw_logs.items():
        (out / "logs" / f"{key}.json").write_bytes(body)
    dues, skipped = plan(config, manifest, parse_logs(raw_logs), now, only=only, repair=repair)
    summary = {"now": now, "built": [], "skipped": skipped, "busy": False, "pages": 0}
    version = time.strftime("%Y-%m-%dT%H%M%SZ", time.gmtime(now))
    pages = budget or config["budget"]
    live = out / "live-manifest.json"
    for due in dues:
        name, key, mode, cut = due["name"], due["key"], due["mode"], due["cut"]
        if summary["busy"]:
            summary["skipped"].append(f"r/{name}: not fetched: Arctic Shift was busy earlier in this run")
            continue
        if config["run_budget"] - summary["pages"] < 2:
            summary["skipped"].append(f"r/{name}: not fetched: the run budget ({config['run_budget']} pages) is spent")
            continue
        bundle = out / "bundles" / f"{len(summary['built']) + 1:02d}-{key}"
        fetched = {}
        try:
            if mode != "first":
                download_build(get, public, manifest["subreddits"][key], key, archive)
            for kind in ("posts", "comments"):
                # What's left of the run's budget, keeping a page back for the comments.
                left = config["run_budget"] - summary["pages"] - (1 if kind == "posts" else 0)
                fetched[kind] = fetch(fetch_cmd, name, kind, cut, now - SETTLE, min(pages, left), out / "fetch" / key)
                summary["pages"] += fetched[kind]["pages"]
                if fetched[kind]["busy"]:
                    summary["busy"] = True
                    raise Skip(f"r/{name}: Arctic Shift was busy ({fetched[kind]['error']}), so this run stops fetching")
            through = {kind: r["complete_through"] for kind, r in fetched.items()}
            if not all(check_upload.is_time(t) for t in through.values()):
                raise Skip(f"r/{name}: the fetch got nothing to build from")
            try:
                build_dumps.build(name, out / "fetch" / key / "posts.jsonl", out / "fetch" / key / "comments.jsonl", archive,
                                  version=version, now=now, log=log, splice=None if mode == "first" else archive, cut=cut,
                                  posts_through=through["posts"], comments_through=through["comments"])
            except SystemExit as err:
                raise Skip(f"r/{name}: {err}")
            merge(name, key, archive, live, out / "logs" / f"{key}.json", bundle, now, mode == "repair")
        except Skip as why:
            summary["skipped"].append(str(why))
            continue
        live = bundle / "manifest.json"
        done = {"name": name, "key": key, "mode": mode, "cut": cut, "version": version, "bundle": bundle.name,
                "fetched": {k: {f: r[f] for f in ("requests", "items", "reached_end", "complete_through")}
                            for k, r in fetched.items()}}
        summary["built"].append(done)
        log(f"r/{name}: {mode} from {utc(cut)}: {fetched['posts']['items']:,} posts and {fetched['comments']['items']:,} "
            f"comments in {sum(r['requests'] for r in fetched.values())} requests; bundle {bundle.name}")
    for line in summary["skipped"]:
        log(line)
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8", newline="\n")
    return summary


def main(argv: list[str] | None = None, get=None, fetch_cmd: list[str] | None = None, now: int | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--config", type=Path, default=CONFIG, help="the sync's config (default: tools/archive.json)")
    parser.add_argument("--public", default=PUBLIC, help="the archive's public URL (default: DUMPS_URL, or the live one)")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("plan", help="say which subreddits are due, and why")
    b = commands.add_parser("build", help="build bundles for the due subreddits")
    b.add_argument("--out", type=Path, required=True, help="a new directory for the bundles and the work")
    b.add_argument("--only", metavar="NAME", help="build just this subreddit, due or not")
    b.add_argument("--repair", metavar="NAME", help="repair just this subreddit")
    b.add_argument("--budget", type=int, metavar="PAGES", help="pages per fetch (default: the config's)")
    args = parser.parse_args(argv)
    if not args.public.startswith("https://"):
        raise SystemExit("--public must be an https:// URL")
    try:
        config = parse_config(json.loads(args.config.read_text(encoding="utf-8")))
    except (OSError, ValueError) as err:
        raise SystemExit(f"can't read {args.config}: {err}")
    now = int(now if now is not None else time.time())
    get = get or http_get
    if args.command == "plan":
        _, manifest, raw_logs = read_live(get, args.public, config["subreddits"], now)
        dues, skipped = plan(config, manifest, parse_logs(raw_logs), now)
        for d in dues:
            print(f"r/{d['name']}: {d['mode']} from {utc(d['cut'])}")
        for line in skipped:
            print(line)
        return
    if args.budget is not None and not 1 <= args.budget <= MAX_BUDGET:
        raise SystemExit(f"--budget must be 1 to {MAX_BUDGET} pages")
    build(config, args.out, now, get, fetch_cmd or FETCHER, args.public, only=args.only, repair=args.repair,
          budget=args.budget)


if __name__ == "__main__":
    main()
