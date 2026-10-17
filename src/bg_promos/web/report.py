"""User error reports -> Telegram, with in-memory anti-spam.

Order of checks for POST /api/v1/report:
1. payload validation (400);
2. honeypot filled or form open < 3 s -> silent ``200 {"ok": true}`` (nothing sent);
3. Telegram not configured -> 503;
4. rate limits per IP (hourly / daily) and global daily -> 429
   (only requests that passed 1-3 are counted);
5. one Telegram ``sendMessage`` call, plain text. A timeout means "maybe
   delivered", so there is no retry: the user gets 503 and may resend.
"""

from __future__ import annotations

import hashlib
import ipaddress
import logging
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field

from ..config import Settings

log = logging.getLogger(__name__)
# httpx logs full request URLs at INFO, and the Telegram URL contains the bot token.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

MIN_ELAPSED_MS = 3000
TELEGRAM_TIMEOUT = 10.0
TELEGRAM_URL = "https://api.telegram.org/bot{token}/sendMessage"


class ReportIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    message: str = Field(min_length=5, max_length=1000)
    offer_id: str | None = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]*$")
    page_url: str | None = Field(default=None, max_length=300)
    lang: Literal["bg", "ru"]
    hp: str = Field(default="", max_length=1000)
    elapsed_ms: int = Field(ge=0, le=10**9)


@dataclass(slots=True)
class ReportResult:
    status: int
    body: dict[str, Any]


class RateLimiter:
    """Sliding-window limits kept in memory: per IP (hour, day) and global (day)."""

    HOUR = 3600.0
    DAY = 86400.0

    def __init__(self, hourly_per_ip: int, daily_per_ip: int, daily_global: int) -> None:
        self.hourly_per_ip = hourly_per_ip
        self.daily_per_ip = daily_per_ip
        self.daily_global = daily_global
        self._ips: dict[str, deque[float]] = {}
        self._global: deque[float] = deque()
        self._lock = threading.Lock()

    def try_acquire(self, ip: str, now: float) -> bool:
        """Record an accepted request; False (and nothing recorded) when a limit is hit."""
        with self._lock:
            self._prune(now)
            hits = self._ips.setdefault(ip, deque())
            hourly = sum(1 for t in hits if now - t < self.HOUR)
            if (
                len(self._global) >= self.daily_global
                or len(hits) >= self.daily_per_ip
                or hourly >= self.hourly_per_ip
            ):
                if not hits:
                    del self._ips[ip]
                return False
            hits.append(now)
            self._global.append(now)
            return True

    def _prune(self, now: float) -> None:
        while self._global and now - self._global[0] >= self.DAY:
            self._global.popleft()
        for ip in list(self._ips):
            hits = self._ips[ip]
            while hits and now - hits[0] >= self.DAY:
                hits.popleft()
            if not hits:
                del self._ips[ip]


def parse_networks(values: tuple[str, ...] | list[str]) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    nets = []
    for v in values:
        try:
            nets.append(ipaddress.ip_network(v.strip(), strict=False))
        except ValueError:
            log.warning("ignored invalid trusted_proxies entry %r", v)
    return nets


def client_ip(peer: str | None, forwarded_for: str | None, trusted: list) -> str:
    """Client address from X-Forwarded-For, walked right to left from the direct peer.

    Hops added by trusted proxies are skipped; the first untrusted hop is the client
    (so a spoofed leftmost value is ignored). All hops trusted -> the leftmost one.
    An unparsable hop stops the walk and the last good address is returned.
    """
    peer = peer or "unknown"
    try:
        peer_ip = ipaddress.ip_address(peer)
    except ValueError:
        return peer
    if not forwarded_for or not any(peer_ip in net for net in trusted):
        return peer
    current = peer_ip
    for raw in reversed(forwarded_for.split(",")):
        try:
            hop = ipaddress.ip_address(raw.strip())
        except ValueError:
            return str(current)
        current = hop
        if not any(hop in net for net in trusted):
            break
    return str(current)


class ReportService:
    def __init__(
        self,
        settings: Settings,
        transport: httpx.BaseTransport | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.settings = settings
        self.transport = transport
        self.clock = clock
        self.limiter = RateLimiter(
            settings.report_hourly_per_ip, settings.report_daily_per_ip, settings.report_daily_global
        )
        self.trusted = parse_networks(settings.trusted_proxies)
        if not self.trusted:
            log.warning("trusted_proxies is empty: X-Forwarded-For is ignored, every report "
                        "will be attributed to the direct peer (the proxy)")

    @property
    def enabled(self) -> bool:
        return bool(self.settings.telegram_bot_token and self.settings.telegram_chat_id)

    def client_ip(self, peer: str | None, forwarded_for: str | None) -> str:
        return client_ip(peer, forwarded_for, self.trusted)

    def handle(self, report: ReportIn, ip: str) -> ReportResult:
        ip_hash = hashlib.sha256(ip.encode("utf-8")).hexdigest()[:10]
        if report.hp or report.elapsed_ms < MIN_ELAPSED_MS:
            log.info("report dropped silently (honeypot=%s, elapsed_ms=%d, ip_hash=%s)",
                     bool(report.hp), report.elapsed_ms, ip_hash)
            return ReportResult(200, {"ok": True})
        if not self.enabled:
            log.warning("report received but Telegram is not configured")
            return ReportResult(503, {"detail": "reporting not configured"})
        if not self.limiter.try_acquire(ip, self.clock()):
            log.info("report rate limited (ip_hash=%s)", ip_hash)
            return ReportResult(429, {"detail": "too many reports, try later"})
        text = (
            "BG Promos — съобщение за грешка\n"
            f"Език: {report.lang}\n"
            f"Оферта: {report.offer_id or '-'}\n"
            f"Страница: {report.page_url or '-'}\n"
            f"IP hash: {ip_hash}\n\n"
            f"{report.message}"
        )
        return self._send(text)

    def _send(self, text: str) -> ReportResult:
        s = self.settings
        try:
            with httpx.Client(transport=self.transport, timeout=TELEGRAM_TIMEOUT) as client:
                resp = client.post(
                    TELEGRAM_URL.format(token=s.telegram_bot_token),
                    json={"chat_id": s.telegram_chat_id, "text": text, "disable_web_page_preview": True},
                )
        except Exception as exc:  # noqa: BLE001 - incl. httpx.InvalidURL, which is not an HTTPError
            # Never log the exception text: it may contain the URL with the bot token.
            log.error("telegram request failed: %s", type(exc).__name__)
            return ReportResult(503, {"detail": "telegram unavailable"})
        if resp.status_code >= 400:
            log.error("telegram answered HTTP %d", resp.status_code)
            return ReportResult(503, {"detail": "telegram unavailable"})
        return ReportResult(200, {"ok": True})
