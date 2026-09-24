from collections import Counter

import httpx
import pytest

from reddit_tool.api import ArcticShiftError, _yearly_ranges


def test_get_post(client, mock_api):
    mock_api.get("/api/posts/ids", params={"ids": "abc123"}).respond(
        json={"data": [{"id": "abc123", "author": "op", "subreddit": "Python", "created_utc": 1700000000, "title": "Hi"}]}
    )
    post = client.get_post("abc123")
    assert (post.id, post.author, post.subreddit, post.created_utc) == ("abc123", "op", "Python", 1700000000)


def test_get_post_missing(client, mock_api):
    mock_api.get("/api/posts/ids").respond(json={"data": []})
    assert client.get_post("zzz") is None


def test_iter_thread_comments_paginates_and_dedupes(client, mock_api):
    page1 = [{"id": f"c{i}", "author": "a", "created_utc": 100 + i} for i in range(3)]
    # Second page overlaps the boundary comment from page 1.
    page2 = [{"id": "c2", "author": "a", "created_utc": 102}, {"id": "c3", "author": "b", "created_utc": 103}]
    route = mock_api.get("/api/comments/search")
    route.side_effect = [httpx.Response(200, json={"data": page1}), httpx.Response(200, json={"data": page2})]

    ids = [c["id"] for c in client.iter_thread_comments("abc123", page_size=3)]

    assert ids == ["c0", "c1", "c2", "c3"]
    first, second = (call.request.url.params for call in route.calls)
    assert "after" not in first and first["link_id"] == "abc123" and first["sort"] == "asc"
    assert second["after"] == "101"


def test_iter_thread_comments_terminates_on_stuck_page(client, mock_api):
    # A full page of comments all sharing one timestamp, returned again and again.
    page = [{"id": f"c{i}", "author": "a", "created_utc": 500} for i in range(2)]
    route = mock_api.get("/api/comments/search")
    route.side_effect = [httpx.Response(200, json={"data": page})] * 3 + [httpx.Response(200, json={"data": []})]

    assert len(list(client.iter_thread_comments("abc123", page_size=2))) == 2
    afters = [call.request.url.params.get("after") for call in route.calls]
    assert afters == [None, "499", "501", "502"]


def test_subreddit_counts_parses_string_counts(client, mock_api):
    route = mock_api.get("/api/comments/search/aggregate").respond(
        json={"data": [{"key": "Python", "count": "12"}, {"key": "rust", "count": "3"}]}
    )
    assert client.subreddit_counts("comments", "alice") == Counter({"Python": 12, "rust": 3})
    params = route.calls.last.request.url.params
    assert params["aggregate"] == "subreddit" and params["author"] == "alice" and params["limit"] == ""


def test_subreddit_counts_passes_filters(client, mock_api):
    route = mock_api.get("/api/posts/search/aggregate").respond(json={"data": []})
    assert client.subreddit_counts("posts", "alice", subreddit="Python", before=123) == Counter()
    params = route.calls.last.request.url.params
    assert params["subreddit"] == "Python" and params["before"] == "123"


def test_rate_limit_is_retried(client, mock_api, sleeps):
    mock_api.get("/api/posts/search/aggregate").side_effect = [
        httpx.Response(429, headers={"X-RateLimit-Reset": "7"}, json={"error": "Too many requests"}),
        httpx.Response(200, json={"data": [{"key": "a", "count": "1"}]}),
    ]
    assert client.subreddit_counts("posts", "alice") == Counter({"a": 1})
    assert sleeps == [8]


def test_server_errors_retry_then_fail(client, mock_api):
    mock_api.get("/api/posts/search/aggregate").respond(500, text="boom")
    with pytest.raises(ArcticShiftError):
        client.subreddit_counts("posts", "alice")
    assert mock_api.calls.call_count == client.max_retries + 1


def test_api_error_payload_raises(client, mock_api):
    mock_api.get("/api/posts/ids").respond(400, json={"error": "Invalid id"})
    with pytest.raises(ArcticShiftError, match="Invalid id"):
        client.get_post("!!")


def test_timeout_falls_back_to_yearly_chunks(client, mock_api):
    timed_out = httpx.Response(200, json={"error": "Query timed out"})

    def handler(request):
        if "after" not in request.url.params:
            return timed_out
        return httpx.Response(200, json={"data": [{"key": "Python", "count": "2"}]})

    route = mock_api.get("/api/comments/search/aggregate").mock(side_effect=handler)
    before = 1_104_537_600 + 10  # 2005-01-01 plus a bit: 1 chunk
    counts = client.subreddit_counts("comments", "busy", before=before)
    assert counts == Counter({"Python": 2})
    assert route.call_count == 3  # two full attempts + one yearly chunk


def test_yearly_ranges_cover_until_before():
    ranges = _yearly_ranges(1_700_000_000)  # 2023-11-14
    assert ranges[0][0] == 1_104_537_600  # 2005-01-01
    assert ranges[-1][1] == 1_700_000_000
    assert len(ranges) == 2023 - 2005 + 1
    assert all(a[1] == b[0] for a, b in zip(ranges, ranges[1:]))


def test_slow_down_is_retried_with_backoff(client, mock_api, sleeps):
    slow = httpx.Response(422, json={"data": None, "error": "Timeout. Maybe slow down a bit"})
    mock_api.get("/api/comments/search/aggregate").side_effect = [
        slow,
        slow,
        httpx.Response(200, json={"data": [{"key": "a", "count": "1"}]}),
    ]
    assert client.subreddit_counts("comments", "alice") == Counter({"a": 1})
    assert sleeps == [5, 10]


def test_persistent_slow_down_falls_back_to_chunks(client, mock_api):
    slow = httpx.Response(422, json={"data": None, "error": "Timeout. Maybe slow down a bit"})

    def handler(request):
        if "after" not in request.url.params:
            return slow
        return httpx.Response(200, json={"data": [{"key": "a", "count": "1"}]})

    mock_api.get("/api/comments/search/aggregate").mock(side_effect=handler)
    assert client.subreddit_counts("comments", "alice", before=1_104_537_610) == Counter({"a": 1})
