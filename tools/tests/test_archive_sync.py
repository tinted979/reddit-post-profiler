"""Tests for tools/archive_sync.py, the archive sync's build job (docs/adr/0005): which
subreddits are due, and the bundles it makes for tools/publish_build.sh. Downloads come from a
fake public URL and fetches from a fake fetcher, so nothing here reaches the network. Run from
the repo root:

  uv run --with duckdb --with pytest pytest tools
"""

import hashlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import archive_sync  # noqa: E402
import build_dumps  # noqa: E402

HOUR, DAY = 3600, 86400
T = 1_790_000_000  # now
PUBLIC = "https://dumps.test"
CONFIG = {
    "subreddits": {"Hasan_Piker": {"cadence": "1h"}, "Python": {"cadence": "6h"}},
    "overlap": "2h", "repair_days": 7, "repair_every": "7d", "budget": 300,
}


def entry(name, built, posts_to, comments_to, version="v1"):
    key = name.lower()
    return {"name": name, "version": version, "built_utc": built, "posts_to_utc": posts_to, "comments_to_utc": comments_to,
            "files": {n: {"path": f"r/{key}/{version}/{n}.parquet", "bytes": 100}
                      for n in ("posts_by_author", "comments_by_author", "comments_by_link")}}


def log(key, *publishes):
    return {"format": 1, "subreddit": key, "publishes": list(publishes)}


def pub(version, hours_ago, replaced=None, repair=False):
    e = {"version": version, "replaced": replaced, "utc": T - hours_ago * HOUR}
    if repair:
        e["repair"] = True
    return e


# Config ---------------------------------------------------------------------------------------

def test_the_repositorys_config_checks_out():
    config = archive_sync.parse_config(json.loads((Path(archive_sync.__file__).parent / "archive.json").read_text(encoding="utf-8")))
    assert "hasan_piker" in config["subreddits"]


def test_parse_config_turns_durations_into_seconds():
    config = archive_sync.parse_config({**CONFIG, "subreddits": {**CONFIG["subreddits"], "AskHistorians": {"cadence": "1d", "backfill": "api"}}})
    assert config["subreddits"]["hasan_piker"] == {"name": "Hasan_Piker", "cadence": HOUR, "backfill": False}
    assert config["subreddits"]["askhistorians"]["backfill"] is True
    assert (config["overlap"], config["repair_days"], config["repair_every"], config["budget"]) == (2 * HOUR, 7, 7 * DAY, 300)


@pytest.mark.parametrize("change, expected", [
    ({"subreddits": {"../x": {"cadence": "1h"}}}, "not a subreddit name"),
    ({"subreddits": {"Python": {"cadence": "1h"}, "python": {"cadence": "1h"}}}, "twice"),
    ({"subreddits": {"Python": {"cadence": "10m"}}}, "cadence"),
    ({"subreddits": {"Python": {"cadence": "8d"}}}, "cadence"),
    ({"subreddits": {"Python": {"cadence": "hourly"}}}, "cadence"),
    ({"subreddits": {"Python": {"cadence": "1h", "backfill": "torrent"}}}, "backfill"),
    ({"subreddits": {"Python": {"cadence": "1h", "extra": 1}}}, "extra"),
    ({"subreddits": {}}, "no subreddits"),
    ({"overlap": "0m"}, "overlap"),
    ({"repair_days": 0}, "repair_days"),
    ({"repair_every": "1h"}, "repair_every"),
    ({"budget": 0}, "budget"),
    ({"budget": 20000}, "budget"),
    ({"surprise": True}, "surprise"),
])
def test_parse_config_refuses(change, expected):
    with pytest.raises(SystemExit, match=expected):
        archive_sync.parse_config({**CONFIG, **change})


# Planning -------------------------------------------------------------------------------------

def planned(manifest_subs, logs=None, config=CONFIG, now=T, **kw):
    dues, skipped = archive_sync.plan(archive_sync.parse_config(config), {"format": 1, "subreddits": manifest_subs},
                                      logs or {}, now, **kw)
    return [(d["key"], d["mode"], d["cut"]) for d in dues], skipped


def test_a_subreddit_is_due_once_its_cadence_has_passed_less_some_slack():
    subs = {"hasan_piker": entry("Hasan_Piker", T - 50 * 60, T - 2 * HOUR, T - 3 * HOUR)}
    assert planned(subs, {"hasan_piker": log("hasan_piker", pub("v1", 1, repair=True))})[0] == [
        ("hasan_piker", "sync", T - 3 * HOUR - 2 * HOUR)]  # 50 minutes, within the slack of an hourly cron
    subs = {"hasan_piker": entry("Hasan_Piker", T - 30 * 60, T - 2 * HOUR, T - 3 * HOUR)}
    dues, skipped = planned(subs, {"hasan_piker": log("hasan_piker", pub("v1", 1, repair=True))})
    assert dues == [] and any("r/Hasan_Piker: not due" in s for s in skipped)


def test_a_repair_comes_once_a_week_and_reaches_back_repair_days():
    subs = {"hasan_piker": entry("Hasan_Piker", T - 2 * HOUR, T - HOUR, T - HOUR)}
    # Last repaired 8 days ago.
    logs = {"hasan_piker": log("hasan_piker", pub("v0", 8 * 24, repair=True), pub("v1", 2, replaced="v0"))}
    assert planned(subs, logs)[0] == [("hasan_piker", "repair", T - HOUR - 7 * DAY)]
    # Never repaired: counted from the first publish the log has, then from the build.
    assert planned(subs, {"hasan_piker": log("hasan_piker", pub("v1", 8 * 24))})[0][0][1] == "repair"
    assert planned(subs, {"hasan_piker": log("hasan_piker", pub("v1", 2))})[0][0][1] == "sync"
    assert planned(subs, {})[0][0][1] == "sync"  # no log: the build is 2 hours old
    assert planned({"hasan_piker": entry("Hasan_Piker", T - 8 * DAY, T - HOUR, T - HOUR)}, {})[0][0][1] == "repair"


def test_a_subreddit_still_catching_up_syncs_rather_than_repairs():
    subs = {"hasan_piker": entry("Hasan_Piker", T - 2 * HOUR, T - 30 * DAY, T - 30 * DAY)}
    logs = {"hasan_piker": log("hasan_piker", pub("v1", 10 * 24))}
    assert planned(subs, logs)[0] == [("hasan_piker", "sync", T - 30 * DAY - 2 * HOUR)]


def test_a_subreddit_not_live_yet_is_built_from_the_api_only_when_its_config_says_so():
    dues, skipped = planned({})
    assert dues == [] and any("r/Hasan_Piker isn't in the archive yet" in s for s in skipped)
    config = {**CONFIG, "subreddits": {"Hasan_Piker": {"cadence": "1h", "backfill": "api"}}}
    assert planned({}, config=config)[0] == [("hasan_piker", "first", None)]


def test_caught_up_subreddits_go_first_then_the_most_overdue():
    config = {**CONFIG, "subreddits": {"A1": {"cadence": "1h"}, "B2": {"cadence": "1h"}, "C3": {"cadence": "1h"},
                                       "D4": {"cadence": "1h", "backfill": "api"}}}
    subs = {
        "a1": entry("A1", T - 2 * HOUR, T - 20 * DAY, T - 20 * DAY),  # catching up
        "b2": entry("B2", T - 2 * HOUR, T - HOUR, T - HOUR),
        "c3": entry("C3", T - 5 * HOUR, T - HOUR, T - HOUR),  # more overdue
    }
    logs = {k: log(k, pub("v1", 1, repair=True)) for k in ("a1", "b2", "c3")}
    assert [k for k, _, _ in planned(subs, logs, config=config)[0]] == ["c3", "b2", "a1", "d4"]


def test_only_and_repair_force_a_subreddit():
    subs = {"hasan_piker": entry("Hasan_Piker", T - 10 * 60, T - HOUR, T - HOUR),
            "python": entry("Python", T - 7 * HOUR, T - HOUR, T - HOUR)}
    logs = {k: log(k, pub("v1", 1, repair=True)) for k in subs}
    assert planned(subs, logs, only="Hasan_Piker")[0] == [("hasan_piker", "sync", T - 3 * HOUR)]
    assert planned(subs, logs, repair="hasan_piker")[0] == [("hasan_piker", "repair", T - HOUR - 7 * DAY)]
    with pytest.raises(SystemExit, match="isn't in the config"):
        planned(subs, logs, only="AskHistorians")


def test_a_publish_log_that_doesnt_check_out_skips_its_subreddit():
    subs = {"hasan_piker": entry("Hasan_Piker", T - 2 * HOUR, T - HOUR, T - HOUR)}
    dues, skipped = planned(subs, {"hasan_piker": {"format": 1, "subreddit": "python", "publishes": []}})
    assert dues == [] and any("publish log" in s for s in skipped)


# Building -------------------------------------------------------------------------------------

FAKE_FETCH = r'''
import json, os, sys
args = dict(zip(sys.argv[1::2], sys.argv[2::2]))
world = json.load(open(os.environ["FAKE_WORLD"], encoding="utf-8"))
with open(os.environ["FAKE_CALLS"], "a", encoding="utf-8") as f:
    f.write(json.dumps(args) + "\n")
name, kind = args["--subreddit"], args["--kind"]
after = int(args["--after"]) if "--after" in args else None
before = int(args["--before"])
busy = name in world.get("busy", [])
stop = world.get("stop", {}).get(name)
through = after if busy else (stop - 1 if stop is not None else before - 1)
rows = [] if busy else [r for r in world["rows"].get(name, {}).get(kind, [])
                        if (after is None or r["created_utc"] > after) and r["created_utc"] <= through]
with open(args["--out"], "w", encoding="utf-8") as f:
    f.write("".join(json.dumps({**r, "subreddit": name}) + "\n" for r in rows))
result = {"subreddit": name, "kind": kind, "after": after, "before": before, "pages": 1, "requests": 1 + (5 if busy else 0),
          "items": len(rows), "skipped": 0, "reached_end": not busy and stop is None, "complete_through": through,
          "error": "server busy: slow down" if busy else None, "busy": busy}
with open(args["--result"], "w", encoding="utf-8") as f:
    json.dump(result, f)
sys.exit(3 if busy else 0)
'''


def rows(kind, lo, hi, step, prefix):
    if kind == "posts":
        return [{"id": f"{prefix}p{t}", "author": f"user{t % 5}", "created_utc": t} for t in range(lo, hi, step)]
    return [{"id": f"{prefix}c{t}", "author": f"user{t % 7}", "created_utc": t, "link_id": f"t3_{prefix}p{lo}"}
            for t in range(lo, hi, step)]


def jsonl(path, name, items):
    path.write_text("".join(json.dumps({**r, "subreddit": name}) + "\n" for r in items), encoding="utf-8")
    return path


@pytest.fixture
def world(tmp_path, monkeypatch):
    """The public archive (Hasan_Piker built 3 hours ago, Python 2 hours ago) and what the API
    would answer now: each subreddit's rows up to a minute ago."""
    public = tmp_path / "public"
    quiet = lambda *_: None  # noqa: E731
    api = {}
    for name, built, prefix in (("Hasan_Piker", T - 3 * HOUR, "h"), ("Python", T - 2 * HOUR, "y")):
        start = T - 10 * DAY
        every = {k: rows(k, start, T - 100, 1800 if k == "posts" else 600, prefix) for k in ("posts", "comments")}
        api[name] = every
        live = {k: [r for r in v if r["created_utc"] <= built - HOUR] for k, v in every.items()}
        build_dumps.build(name, jsonl(tmp_path / f"{prefix}p.jsonl", name, live["posts"]),
                          jsonl(tmp_path / f"{prefix}c.jsonl", name, live["comments"]), public,
                          version=f"v-{prefix}", now=built, posts_through=built - HOUR, comments_through=built - HOUR, log=quiet)
    key = "hasan_piker"
    (public / "r" / key / "published.json").write_text(
        json.dumps(log(key, pub("v-h", 3, replaced="hand-made", repair=True))), encoding="utf-8")
    fake = tmp_path / "fake_fetch.py"
    fake.write_text(FAKE_FETCH, encoding="utf-8")
    state = {"rows": api}
    world_path = tmp_path / "world.json"
    calls = tmp_path / "calls.jsonl"
    monkeypatch.setenv("FAKE_WORLD", str(world_path))
    monkeypatch.setenv("FAKE_CALLS", str(calls))

    def get(url):
        path = url[len(PUBLIC) + 1:].split("?")[0]
        f = public / path
        return (200, f.read_bytes()) if f.is_file() else (404, b"")

    def build(config=CONFIG, **kw):
        world_path.write_text(json.dumps(state), encoding="utf-8")
        return archive_sync.build(archive_sync.parse_config(config), tmp_path / "out", T, get,
                                  [sys.executable, str(fake)], PUBLIC, log=quiet, **kw)

    def fetches():
        return [json.loads(line) for line in calls.read_text(encoding="utf-8").splitlines()] if calls.exists() else []

    return {"public": public, "out": tmp_path / "out", "build": build, "fetches": fetches, "state": state}


def test_build_makes_a_bundle_for_each_due_subreddit(world):
    summary = world["build"]()
    out, public = world["out"], world["public"]
    # Hasan_Piker is due (hourly, built 3 hours ago); Python isn't (every 6 hours, built 2 hours ago).
    assert [s["name"] for s in summary["built"]] == ["Hasan_Piker"]
    assert any("r/Python: not due" in s for s in summary["skipped"])
    # From the cut (the older cutoff less 2 hours) to a minute ago, one fetch per kind.
    cut = T - 4 * HOUR - 2 * HOUR
    assert [(f["--subreddit"], f["--kind"], f["--after"], f["--before"], f["--budget"]) for f in world["fetches"]()] == [
        ("Hasan_Piker", "posts", str(cut), str(T - 60), "300"), ("Hasan_Piker", "comments", str(cut), str(T - 60), "300")]
    bundle = out / "bundles" / "01-hasan_piker"
    version = (bundle / "version").read_text(encoding="utf-8").strip()
    assert version == "2026-09-21T141320Z"  # the run's time
    assert (bundle / "live.sha256").read_text(encoding="utf-8").strip() == hashlib.sha256((public / "manifest.json").read_bytes()).hexdigest()
    merged = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
    live = json.loads((public / "manifest.json").read_text(encoding="utf-8"))
    assert merged["subreddits"]["python"] == live["subreddits"]["python"]
    new = merged["subreddits"]["hasan_piker"]
    assert (new["version"], new["built_utc"], new["posts_to_utc"], new["comments_to_utc"]) == (version, T, T - 61, T - 61)
    published = json.loads((bundle / "r/hasan_piker/published.json").read_text(encoding="utf-8"))
    assert published["publishes"][-1] == {"version": version, "replaced": "v-h", "utc": T}
    assert json.loads((out / "summary.json").read_text(encoding="utf-8")) == summary
    assert summary["built"][0]["bundle"] == "01-hasan_piker" and summary["built"][0]["mode"] == "sync"


def test_several_due_subreddits_make_bundles_that_publish_in_turn(world):
    config = {**CONFIG, "subreddits": {"Hasan_Piker": {"cadence": "1h"}, "Python": {"cadence": "1h"}}}
    summary = world["build"](config)
    assert [s["bundle"] for s in summary["built"]] == ["01-hasan_piker", "02-python"]
    first, second = world["out"] / "bundles" / "01-hasan_piker", world["out"] / "bundles" / "02-python"
    # The second is made on the manifest the first will leave live, so publish_build.sh's check
    # passes for it only once the first has gone up.
    assert (second / "live.sha256").read_text(encoding="utf-8").strip() == hashlib.sha256((first / "manifest.json").read_bytes()).hexdigest()
    merged = json.loads((second / "manifest.json").read_text(encoding="utf-8"))["subreddits"]
    assert merged["hasan_piker"]["built_utc"] == T and merged["python"]["built_utc"] == T


def test_a_repair_is_marked_in_the_publish_log(world):
    summary = world["build"](repair="Hasan_Piker")
    assert summary["built"][0]["mode"] == "repair"
    assert world["fetches"]()[0]["--after"] == str(T - 4 * HOUR - 7 * DAY)
    published = json.loads((world["out"] / "bundles/01-hasan_piker/r/hasan_piker/published.json").read_text(encoding="utf-8"))
    assert published["publishes"][-1]["repair"] is True


def test_a_busy_server_stops_the_run_and_keeps_the_bundles_made(world):
    config = {**CONFIG, "subreddits": {"Hasan_Piker": {"cadence": "1h"}, "Python": {"cadence": "1h"}}}
    world["state"]["busy"] = ["Python"]
    summary = world["build"](config)
    assert [s["name"] for s in summary["built"]] == ["Hasan_Piker"] and summary["busy"] is True
    assert any("r/Python" in s and "busy" in s for s in summary["skipped"])
    # Python's posts fetch found the server busy, so its comments weren't asked for.
    assert [(f["--subreddit"], f["--kind"]) for f in world["fetches"]()][-1] == ("Python", "posts")

    world["state"]["busy"] = ["Hasan_Piker"]
    import shutil
    shutil.rmtree(world["out"])
    open(world["out"].parent / "calls.jsonl", "w").close()
    summary = world["build"](config)
    assert summary["built"] == [] and [f["--subreddit"] for f in world["fetches"]()] == ["Hasan_Piker"]


def test_a_fetch_that_stops_short_of_the_live_cutoff_skips_its_subreddit(world):
    config = {**CONFIG, "subreddits": {"Hasan_Piker": {"cadence": "1h"}, "Python": {"cadence": "1h"}}}
    world["state"]["stop"] = {"Hasan_Piker": T - 5 * HOUR}  # the live build reaches T-4h
    summary = world["build"](config)
    assert [s["name"] for s in summary["built"]] == ["Python"]
    assert [s["bundle"] for s in summary["built"]] == ["01-python"]
    assert any("r/Hasan_Piker" in s and "earlier than the live build" in s for s in summary["skipped"])


def test_a_first_build_fetches_from_the_start(world):
    config = {**CONFIG, "subreddits": {"Fresh": {"cadence": "1h", "backfill": "api"}}}
    world["state"]["rows"]["Fresh"] = {k: rows(k, T - 5 * DAY, T - 100, 3600, "f") for k in ("posts", "comments")}
    summary = world["build"](config)
    assert summary["built"][0]["mode"] == "first"
    assert all("--after" not in f for f in world["fetches"]())
    merged = json.loads((world["out"] / "bundles/01-fresh/manifest.json").read_text(encoding="utf-8"))["subreddits"]
    assert set(merged) == {"fresh", "hasan_piker", "python"} and merged["fresh"]["posts_to_utc"] == T - 61


def test_nothing_due_makes_no_bundles(world):
    summary = world["build"]({**CONFIG, "subreddits": {"Python": {"cadence": "6h"}}})
    assert summary["built"] == []
    assert not (world["out"] / "bundles").exists()
    assert world["fetches"]() == []


def test_build_refuses_to_reuse_an_output_directory(world):
    world["out"].mkdir()
    with pytest.raises(SystemExit, match="already exists"):
        world["build"]()
