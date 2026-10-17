"""Polite HTTP client: fixed delay between requests, bounded retries, no block bypassing."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any

import httpx

log = logging.getLogger(__name__)

MAX_RETRY_AFTER = 60.0
_RETRY_STATUSES = {429, 500, 502, 503, 504}


class HttpBlockedError(Exception):
    """The site refused us (403). We never retry or work around it."""


class HttpClient:
    def __init__(
        self,
        user_agent: str,
        timeout: float = 30.0,
        delay_seconds: float = 1.0,
        retries: int = 3,
        backoff_seconds: float = 2.0,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.delay_seconds = delay_seconds
        self.retries = retries
        self.backoff_seconds = backoff_seconds
        self._sleep = sleep
        self._clock = clock
        self._last_request: float | None = None
        self._client = httpx.Client(
            headers={"User-Agent": user_agent, "Accept-Language": "bg-BG,bg;q=0.9,en;q=0.5"},
            timeout=timeout,
            follow_redirects=True,
            transport=transport,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> HttpClient:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def _wait_turn(self) -> None:
        if self._last_request is not None and self.delay_seconds > 0:
            remaining = self.delay_seconds - (self._clock() - self._last_request)
            if remaining > 0:
                self._sleep(remaining)

    @staticmethod
    def _retry_after(resp: httpx.Response) -> float | None:
        value = resp.headers.get("Retry-After")
        if value and value.strip().isdigit():
            return min(float(value), MAX_RETRY_AFTER)
        return None

    def get(self, url: str, params: dict[str, Any] | None = None) -> httpx.Response:
        attempt = 0
        while True:
            self._wait_turn()
            try:
                resp = self._client.get(url, params=params)
            except httpx.TransportError as exc:  # timeouts, connect/read/remote-protocol errors
                self._last_request = self._clock()
                if attempt >= self.retries:
                    raise
                log.warning("GET %s failed (%s), retry %d/%d", url, type(exc).__name__, attempt + 1, self.retries)
                self._sleep(min(self.backoff_seconds * 2**attempt, MAX_RETRY_AFTER))
                attempt += 1
                continue
            self._last_request = self._clock()
            if resp.status_code == 403:
                raise HttpBlockedError(f"403 Forbidden for {url}")
            if resp.status_code in _RETRY_STATUSES and attempt < self.retries:
                wait = self._retry_after(resp)
                if wait is None:
                    wait = min(self.backoff_seconds * 2**attempt, MAX_RETRY_AFTER)
                log.warning("GET %s -> %d, retry %d/%d in %.1fs", url, resp.status_code, attempt + 1, self.retries, wait)
                self._sleep(wait)
                attempt += 1
                continue
            resp.raise_for_status()
            return resp
