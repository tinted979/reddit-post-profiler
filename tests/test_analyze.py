import httpx

from reddit_tool.analyze import build_profile, collect_commenters


def test_collect_commenters_counts_and_filters(client, mock_api, post):
    comments = [
        {"id": "1", "author": "alice", "created_utc": 1},
        {"id": "2", "author": "alice", "created_utc": 2},
        {"id": "3", "author": "bob", "created_utc": 3},
        {"id": "4", "author": "[deleted]", "created_utc": 4},
        {"id": "5", "author": "AutoModerator", "created_utc": 5},
        {"id": "6", "author": "SpamBot", "created_utc": 6},
    ]
    mock_api.get("/api/comments/search").respond(json={"data": comments})

    counts = collect_commenters(client, post, exclude=["u/spambot"])
    assert dict(counts) == {"alice": 2, "bob": 1}


def test_collect_commenters_include_op(client, mock_api, post):
    mock_api.get("/api/comments/search").respond(json={"data": [{"id": "1", "author": "alice", "created_utc": 1}]})
    counts = collect_commenters(client, post, include_op=True)
    assert dict(counts) == {"alice": 1, "op_user": 0}


def test_build_profile(client, mock_api, post):
    def handler(request):
        params = request.url.params
        kind = "posts" if "/posts/" in request.url.path else "comments"
        if "subreddit" in params:
            assert params["subreddit"] == "Python" and params["before"] == str(post.created_utc)
            data = {"posts": [{"key": "Python", "count": "1"}], "comments": [{"key": "Python", "count": "4"}]}[kind]
        else:
            data = {
                "posts": [{"key": "Python", "count": "2"}, {"key": "rust", "count": "1"}],
                "comments": [{"key": "python", "count": "10"}, {"key": "AskReddit", "count": "5"}],
            }[kind]
        return httpx.Response(200, json={"data": data})

    mock_api.get(path__regex=r"/api/(posts|comments)/search/aggregate").mock(side_effect=handler)

    p = build_profile(client, "alice", 3, post)
    assert p.thread_comments == 3
    assert (p.target_posts_before, p.target_comments_before) == (1, 4)
    assert {k: (v.posts, v.comments) for k, v in p.subreddits.items()} == {
        "Python": (2, 10),
        "rust": (1, 0),
        "AskReddit": (0, 5),
    }
