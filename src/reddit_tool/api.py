"""Thin client for the Arctic Shift Reddit archive API.

Docs: https://github.com/ArthurHeitmann/arctic_shift/blob/master/api/README.md
"""

from __future__ import annotations

import time
from collections import Counter
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

import httpx

BASE_URL = "https://arctic-shift.photon-reddit.com"
USER_AGENT = "reddit-tool/0.1 (+https://github.com/tinted979/reddit-tool)"

# Reddit launched in 2005; nothing in the archive is older than this.
ARCHIVE_START_YEAR = 2005

Kind = Literal["posts", "comments"]


class ArcticShiftError(RuntimeError):
    """The API returned an error payload or kept failing after retries."""


class QueryTimeout(ArcticShiftError):
    """The API gave up on a query ("Query timed out"), usually a very active user."""


@dataclass(frozen=True)
class Post:
    id: str
    author: str
    subreddit: str
    created_utc: int
    title: str


class ArcticShiftClient:
    def __init__(
        self,
        *,
        delay: float = 2.0,
        max_retries: int = 4,
        max_rate_limit_waits: int = 10,
        base_url: str = BASE_URL,
        http: httpx.Client | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.delay = delay
        self.max_retries = max_retries
        self.max_rate_limit_waits = max_rate_limit_waits
        self._http = http or httpx.Client(
            base_url=base_url, timeout=60.0, headers={"User-Agent": USER_AGENT}
        )
        self._sleep = sleep
        self._clock = clock
        self._last_request: float | None = None

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> ArcticShiftClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- transport ---------------------------------------------------------

    def _throttle(self) -> None:
        if self._last_request is not None and self.delay > 0:
            wait = self.delay - (self._clock() - self._last_request)
            if wait > 0:
                self._sleep(wait)
        self._last_request = self._clock()

    def _get(self, path: str, params: dict[str, Any]) -> Any:
        """GET `path` and return the payload's `data`, retrying transient failures."""
        failures = 0
        slowdowns = 0
        rate_limit_waits = 0
        while True:
            self._throttle()
            try:
                resp = self._http.get(path, params=params)
            except httpx.TransportError as exc:
                failures += 1
                if failures > self.max_retries:
                    raise ArcticShiftError(f"network error on {path}: {exc}") from exc
                self._sleep(2**failures)
                continue

            if resp.status_code == 429:
                rate_limit_waits += 1
                if rate_limit_waits > self.max_rate_limit_waits:
                    raise ArcticShiftError(f"still rate limited on {path}, giving up")
                self._sleep(_reset_seconds(resp) + 1)
                continue

            try:
                payload = resp.json()
            except ValueError:
                payload = None

            error = payload.get("error") if isinstance(payload, dict) else None
            if error and "timed out" in str(error).lower():
                raise QueryTimeout(str(error))
            if error and "slow down" in str(error).lower():
                # Undocumented: under load the server answers 422 "Timeout. Maybe slow
                # down a bit"; the same query usually succeeds after a pause.
                slowdowns += 1
                if slowdowns > self.max_retries:
                    raise QueryTimeout(str(error))
                self._sleep(5 * 2 ** (slowdowns - 1))
                continue

            if resp.status_code >= 500 or payload is None:
                failures += 1
                if failures > self.max_retries:
                    raise ArcticShiftError(
                        f"HTTP {resp.status_code} on {path}: {error or resp.text[:200]}"
                    )
                self._sleep(2**failures)
                continue

            if error or resp.status_code >= 400:
                raise ArcticShiftError(f"HTTP {resp.status_code} on {path}: {error}")
            return payload.get("data")

    # -- endpoints ---------------------------------------------------------

    def get_post(self, post_id: str) -> Post | None:
        data = self._get(
            "/api/posts/ids",
            {"ids": post_id, "fields": "id,author,subreddit,created_utc,title"},
        )
        if not data:
            return None
        p = data[0]
        return Post(
            id=p["id"],
            author=p.get("author") or "[deleted]",
            subreddit=p["subreddit"],
            created_utc=int(p["created_utc"]),
            title=p.get("title") or "",
        )

    def iter_thread_comments(self, post_id: str, page_size: int = 100) -> Iterator[dict]:
        """Yield every archived comment under a post (fields: id, author, created_utc).

        The search endpoint has no cursor, so we page on `created_utc` and dedupe by id.
        """
        seen: set[str] = set()
        cursor: int | None = None
        while True:
            params: dict[str, Any] = {
                "link_id": post_id,
                "limit": page_size,
                "sort": "asc",
                "fields": "id,author,created_utc",
            }
            if cursor is not None:
                params["after"] = cursor
            page = self._get("/api/comments/search", params) or []

            new = 0
            for c in page:
                if c["id"] in seen:
                    continue
                seen.add(c["id"])
                new += 1
                yield c

            if len(page) < page_size:
                return
            last_ts = int(page[-1]["created_utc"])
            # Step back one second so comments sharing the boundary timestamp are not
            # skipped (whether `after` is inclusive is undocumented); if a page brought
            # nothing new, step past it so we can't loop forever.
            next_cursor = last_ts - 1 if new else last_ts + 1
            if cursor is not None and next_cursor <= cursor:
                next_cursor = cursor + 1
            cursor = next_cursor

    def subreddit_counts(
        self,
        kind: Kind,
        author: str,
        *,
        subreddit: str | None = None,
        before: int | None = None,
    ) -> Counter[str]:
        """Number of posts/comments by `author`, keyed by subreddit.

        Very active users can make the aggregate time out; in that case retry once, then
        split the query into yearly chunks and add them up.
        """
        try:
            return self._aggregate(kind, author, subreddit=subreddit, before=before)
        except QueryTimeout:
            pass
        try:
            return self._aggregate(kind, author, subreddit=subreddit, before=before)
        except QueryTimeout:
            pass

        total: Counter[str] = Counter()
        for start, end in _yearly_ranges(before):
            total.update(
                self._aggregate(
                    kind, author, subreddit=subreddit, after=start, before=end
                )
            )
        return total

    def _aggregate(
        self,
        kind: Kind,
        author: str,
        *,
        subreddit: str | None = None,
        after: int | None = None,
        before: int | None = None,
    ) -> Counter[str]:
        params: dict[str, Any] = {"aggregate": "subreddit", "author": author, "limit": ""}
        if subreddit is not None:
            params["subreddit"] = subreddit
        if after is not None:
            params["after"] = after
        if before is not None:
            params["before"] = before
        data = self._get(f"/api/{kind}/search/aggregate", params) or []
        counts: Counter[str] = Counter()
        for row in data:
            counts[row["key"]] += int(row["count"])
        return counts


def _reset_seconds(resp: httpx.Response) -> float:
    try:
        return max(0.0, float(resp.headers.get("X-RateLimit-Reset", "10")))
    except ValueError:
        return 10.0


def _yearly_ranges(before: int | None) -> list[tuple[int, int]]:
    """[start, end) epoch-second ranges, one per calendar year, up to `before` or now."""
    end_ts = before if before is not None else int(time.time()) + 1
    end_year = datetime.fromtimestamp(end_ts, UTC).year
    ranges = []
    for year in range(ARCHIVE_START_YEAR, end_year + 1):
        start = int(datetime(year, 1, 1, tzinfo=UTC).timestamp())
        stop = min(int(datetime(year + 1, 1, 1, tzinfo=UTC).timestamp()), end_ts)
        if start < stop:
            ranges.append((start, stop))
    return ranges
