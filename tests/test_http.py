from __future__ import annotations

import httpx
import pytest

from bg_promos.http import HttpBlockedError, HttpClient


class Clock:
    """Fake monotonic clock that sleeping advances."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds

    def __call__(self) -> float:
        return self.now


def client(handler, clock, **kw):
    kw.setdefault("delay_seconds", 0)
    return HttpClient("test-ua", transport=httpx.MockTransport(handler), sleep=clock.sleep, clock=clock, **kw)


def test_503_then_200_is_retried_with_backoff():
    clock, statuses = Clock(), [503, 503, 200]

    def handler(request):
        return httpx.Response(statuses.pop(0), text="ok")

    with client(handler, clock, backoff_seconds=2) as http:
        resp = http.get("https://x.test/")
    assert resp.status_code == 200
    assert statuses == []
    assert clock.sleeps == [2, 4]


def test_retry_after_is_respected_and_capped():
    clock, calls = Clock(), []

    def handler(request):
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(429, headers={"Retry-After": "7"})
        if len(calls) == 2:
            return httpx.Response(429, headers={"Retry-After": "9999"})
        return httpx.Response(200)

    with client(handler, clock) as http:
        http.get("https://x.test/")
    assert clock.sleeps == [7, 60]


def test_gives_up_after_retries():
    clock, calls = Clock(), []

    def handler(request):
        calls.append(1)
        return httpx.Response(500)

    with client(handler, clock, retries=2) as http, pytest.raises(httpx.HTTPStatusError):
        http.get("https://x.test/")
    assert len(calls) == 3


def test_403_raises_blocked_without_retry():
    clock, calls = Clock(), []

    def handler(request):
        calls.append(1)
        return httpx.Response(403)

    with client(handler, clock) as http, pytest.raises(HttpBlockedError):
        http.get("https://x.test/")
    assert len(calls) == 1 and clock.sleeps == []


def test_other_4xx_not_retried():
    clock, calls = Clock(), []

    def handler(request):
        calls.append(1)
        return httpx.Response(404)

    with client(handler, clock) as http, pytest.raises(httpx.HTTPStatusError):
        http.get("https://x.test/")
    assert len(calls) == 1


def test_timeout_is_retried():
    clock, calls = Clock(), []

    def handler(request):
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ConnectTimeout("slow", request=request)
        return httpx.Response(200)

    with client(handler, clock) as http:
        assert http.get("https://x.test/").status_code == 200
    assert len(calls) == 2 and len(clock.sleeps) == 1


def test_read_error_is_retried():
    clock, calls = Clock(), []

    def handler(request):
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ReadError("connection reset", request=request)
        return httpx.Response(200)

    with client(handler, clock) as http:
        assert http.get("https://x.test/").status_code == 200
    assert len(calls) == 2 and len(clock.sleeps) == 1


def test_delay_between_requests_and_headers():
    clock, seen = Clock(), []

    def handler(request):
        seen.append(request.headers)
        return httpx.Response(200)

    with client(handler, clock, delay_seconds=1.5) as http:
        http.get("https://x.test/a")
        http.get("https://x.test/b")
        clock.now += 10  # long pause: no extra wait needed
        http.get("https://x.test/c")
    assert clock.sleeps == [1.5]
    assert seen[0]["user-agent"] == "test-ua"
    assert seen[0]["accept-language"].startswith("bg-BG")


def test_redirects_followed():
    clock = Clock()

    def handler(request):
        if request.url.path == "/a":
            return httpx.Response(302, headers={"Location": "https://x.test/b"})
        return httpx.Response(200, text="final")

    with client(handler, clock) as http:
        assert http.get("https://x.test/a").text == "final"
