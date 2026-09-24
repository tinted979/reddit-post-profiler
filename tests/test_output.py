import csv

from reddit_tool.analyze import SubCounts, UserProfile
from reddit_tool.output import COLUMNS, write_csv


def read(path):
    with path.open(newline="") as f:
        return list(csv.DictReader(f))


def test_write_csv(tmp_path, post):
    profiles = [
        UserProfile(
            "alice", 3, 1, 4,
            {"rust": SubCounts(1, 0), "Python": SubCounts(2, 10), "AskReddit": SubCounts(0, 5)},
        ),
        UserProfile("ghost", 1),
        UserProfile("busy", 2, error="Query timed out"),
    ]
    out = tmp_path / "out.csv"
    assert write_csv(profiles, post, out) == 5

    rows = read(out)
    assert list(rows[0]) == COLUMNS
    assert [(r["username"], r["subreddit"], r["total"]) for r in rows] == [
        ("alice", "Python", "12"),
        ("alice", "AskReddit", "5"),
        ("alice", "rust", "1"),
        ("ghost", "", ""),
        ("busy", "", ""),
    ]
    assert rows[0]["target_subreddit"] == "Python"
    assert (rows[0]["target_posts_before"], rows[0]["target_comments_before"]) == ("1", "4")
    assert rows[3]["target_posts_before"] == "0" and rows[3]["error"] == ""
    assert rows[4]["target_posts_before"] == "" and rows[4]["error"] == "Query timed out"


def test_write_csv_min_count_keeps_target(tmp_path, post):
    profiles = [UserProfile("alice", 1, subreddits={"python": SubCounts(0, 1), "rust": SubCounts(0, 1), "big": SubCounts(9, 9)})]
    out = tmp_path / "out.csv"
    write_csv(profiles, post, out, min_count=5)
    assert [r["subreddit"] for r in read(out)] == ["big", "python"]
