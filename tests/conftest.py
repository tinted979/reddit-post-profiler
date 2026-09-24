import httpx
import pytest
import respx

from reddit_tool.api import BASE_URL, ArcticShiftClient, Post


@pytest.fixture
def mock_api():
    with respx.mock(base_url=BASE_URL, assert_all_called=False) as router:
        yield router


@pytest.fixture
def sleeps():
    return []


@pytest.fixture
def client(mock_api, sleeps):
    c = ArcticShiftClient(
        delay=0, http=httpx.Client(base_url=BASE_URL), sleep=sleeps.append
    )
    yield c
    c.close()


@pytest.fixture
def post():
    return Post(id="abc123", author="op_user", subreddit="Python", created_utc=1_700_000_000, title="t")
