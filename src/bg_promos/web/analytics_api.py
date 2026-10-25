"""Internal analytics HTTP API: public session/events endpoints and the closed /api/admin/*.

Contract: docs/ANALYTICS.md. Analytics never touches the catalog database; it writes only to
data/analytics.sqlite3 through AnalyticsStore. Secrets (passwords, cookies, initData) are
never logged.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
import secrets
import threading
import time
import uuid
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError

from ..analytics.attribution import LEGACY_SHARE, UNKNOWN, parse_label, resolve_site_source, split_start_param
from ..analytics.events import SERVER_ONLY, EventError, is_automated_ua, is_uuid, validate_event
from ..analytics.store import AnalyticsStore, SessionGone
from ..analytics.telegram import InitDataError, verify_init_data
from ..config import Settings
from .report import client_ip, parse_networks

log = logging.getLogger(__name__)

MAX_BODY = 32 * 1024
MAX_EVENTS = 50
SESSION_PER_MIN = 120
IP_PER_MIN = 600
LOGIN_FAILS = 5
LOGIN_WINDOW_S = 15 * 60
ADMIN_COOKIE = "bgp_admin"
ADMIN_TTL_S = 12 * 3600
RETENTION_DAYS = 13 * 31  # ~13 months
MAX_PERIOD_DAYS = 400
_LANG_RE = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$")
_OPEN_NS = uuid.UUID("6f1d2c1e-5b3a-4f6e-9d57-2b8f4c9a7e10")


class WindowLimiter:
    """In-memory sliding-window counter per key (process-local)."""

    def __init__(self, limit: int, window_s: float, clock: Callable[[], float]) -> None:
        self.limit, self.window, self.clock = limit, window_s, clock
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()
        self._calls = 0

    def _trim(self, key: str, now: float) -> deque[float]:
        q = self._hits.setdefault(key, deque())
        while q and now - q[0] >= self.window:
            q.popleft()
        return q

    def count(self, key: str) -> int:
        with self._lock:
            return len(self._trim(key, self.clock()))

    def record(self, key: str) -> None:
        with self._lock:
            now = self.clock()
            self._trim(key, now).append(now)

    def clear(self, key: str) -> None:
        with self._lock:
            self._hits.pop(key, None)

    def allow(self, key: str) -> bool:
        """Record the hit and return True while under the limit."""
        with self._lock:
            now = self.clock()
            self._calls += 1
            if self._calls % 1000 == 0:
                for k in [k for k in self._hits if not self._trim(k, now)]:
                    del self._hits[k]
            q = self._trim(key, now)
            if len(q) >= self.limit:
                return False
            q.append(now)
            return True


class SessionIn(BaseModel):
    session_id: str
    platform: str
    anon_id: str | None = None
    init_data: str | None = None
    lang: str | None = None
    utm: dict[str, Any] | None = None
    referrer: str | None = None
    start_param: str | None = None
    test: bool = False


class EventsIn(BaseModel):
    token: str
    session_id: str
    events: list[Any]


class LoginIn(BaseModel):
    password: str


class UsersSearchIn(BaseModel):
    """Body of POST /api/admin/users/search: personal search text never goes into a URL."""

    q: str | None = Field(None, max_length=100)
    from_: str | None = Field(None, alias="from", max_length=10)
    to: str | None = Field(None, max_length=10)
    platform: str | None = Field(None, max_length=16)
    lang: str | None = Field(None, max_length=16)
    source_kind: str | None = Field(None, max_length=32)
    source: str | None = Field(None, max_length=64)
    campaign: str | None = Field(None, max_length=64)
    include_test: bool = False
    include_automated: bool = False
    limit: int = Field(50, ge=1, le=200)
    offset: int = Field(0, ge=0)

    model_config = {"populate_by_name": True}


_HEX = re.compile(r"[0-9a-f]+")


def hex_equal(value: object, expected: str) -> bool:
    """Constant-time compare of a client-supplied lowercase-hex MAC with the expected one.

    Anything that is not ASCII hex of the expected length is rejected before compare_digest
    (which raises TypeError on non-ASCII str).
    """
    if not isinstance(value, str) or len(value) != len(expected) or not _HEX.fullmatch(value):
        return False
    return hmac.compare_digest(value.encode("ascii"), expected.encode("ascii"))


class _StripAdminQuery(logging.Filter):
    """uvicorn access log: drop the query string of /api/admin URLs (may hold personal filters)."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str):
            path = args[2]
            if path.startswith("/api/admin") and "?" in path:
                record.args = (*args[:2], path.split("?", 1)[0], *args[3:])
        return True


def install_access_log_filter() -> None:
    lg = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, _StripAdminQuery) for f in lg.filters):
        lg.addFilter(_StripAdminQuery())


@dataclass(frozen=True)
class Filters:
    """Resolved admin query: Sofia date period plus store filter kwargs."""

    start: date
    end: date
    kw: dict


class AnalyticsService:
    def __init__(
        self, settings: Settings, now_fn: Callable[[], datetime] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.settings = settings
        self.now = now_fn or (lambda: datetime.now(timezone.utc))
        self.secret = settings.analytics_secret
        if not self.secret:
            self.secret = secrets.token_hex(32)
            log.warning("ANALYTICS_SECRET is empty: using a random secret for this process; "
                        "analytics tokens and admin sessions reset on every restart")
        self.trusted = parse_networks(settings.trusted_proxies)
        host = (urlsplit(settings.site_url).hostname or "").lower()
        self.own_hosts: tuple[str, ...] = tuple(h for h in (host,) if h)
        self.session_limiter = WindowLimiter(SESSION_PER_MIN, 60, clock)
        self.ip_limiter = WindowLimiter(IP_PER_MIN, 60, clock)
        self.login_limiter = WindowLimiter(LOGIN_FAILS, LOGIN_WINDOW_S, clock)
        self._store: AnalyticsStore | None = None
        self._store_lock = threading.Lock()

    # ---- helpers --------------------------------------------------------------------------
    @property
    def store(self) -> AnalyticsStore:
        with self._store_lock:
            if self._store is None:
                self._store = AnalyticsStore(self.settings.analytics_db_path, self.settings.timezone)
            return self._store

    @property
    def admin_enabled(self) -> bool:
        return bool(self.settings.admin_password)

    def ip(self, request: Request) -> str:
        peer = request.client.host if request.client else None
        return client_ip(peer, request.headers.get("x-forwarded-for"), self.trusted)

    def _mac(self, purpose: str, value: str) -> str:
        return hmac.new(self.secret.encode(), f"{purpose}|{value}".encode(), hashlib.sha256).hexdigest()

    def make_token(self, session_id: str, visitor_id: str) -> str:
        return self._mac("session", f"{session_id}|{visitor_id}")

    def anon_key(self, anon_id: str) -> str:
        return hashlib.sha256((self.secret + anon_id).encode()).hexdigest()

    def make_admin_cookie(self) -> str:
        expiry = str(int(self.now().timestamp()) + ADMIN_TTL_S)
        return f"{expiry}.{self._mac('admin', expiry)}"

    def check_admin_cookie(self, value: str | None) -> bool:
        if not value or "." not in value or len(value) > 200:
            return False
        expiry, _, mac = value.partition(".")
        if not (expiry.isascii() and expiry.isdigit()) or not hex_equal(mac, self._mac("admin", expiry)):
            return False
        return int(expiry) > int(self.now().timestamp())

    def password_ok(self, password: str) -> bool:
        a = hashlib.sha256(password.encode("utf-8", "surrogatepass")).digest()
        b = hashlib.sha256(self.settings.admin_password.encode("utf-8", "surrogatepass")).digest()
        return hmac.compare_digest(a, b)

    # ---- public endpoints -----------------------------------------------------------------
    def create_session(self, body: SessionIn, user_agent: str | None) -> dict:
        s = self.settings
        if not is_uuid(body.session_id):
            raise HTTPException(400, "invalid session_id")
        session_id = body.session_id.lower()
        if body.platform not in ("web", "miniapp"):
            raise HTTPException(400, "invalid platform")
        lang = body.lang.strip().lower()[:8] if body.lang and _LANG_RE.match(body.lang.strip()) else None
        now = self.now()
        store = self.store
        if body.platform == "miniapp":
            if not body.init_data:
                raise HTTPException(401, "invalid init data")
            try:
                verified = verify_init_data(body.init_data, s.promos_bot_token, now=now.timestamp())
            except InitDataError as exc:
                log.info("initData rejected: %s", type(exc).__name__)
                raise HTTPException(401, "invalid init data") from None
            label, _cart = split_start_param(verified.start_param)
            source = parse_label(label, "startapp") if label else UNKNOWN
            if not label and _cart:  # old unlabeled shared-cart link
                source = LEGACY_SHARE
            source_id = store.get_or_create_source(source)
            visitor_id = store.upsert_tg_visitor(verified.user, source_id, now)
            open_event = "miniapp_open"
        else:
            if not body.anon_id or not is_uuid(body.anon_id):
                raise HTTPException(400, "invalid anon_id")
            referrer = body.referrer[:2048] if isinstance(body.referrer, str) else None
            source = resolve_site_source(body.utm or {}, referrer, self.own_hosts)
            source_id = store.get_or_create_source(source)
            visitor_id = store.upsert_anon_visitor(self.anon_key(body.anon_id.lower()), source_id, now)
            open_event = "site_open"
        created = store.start_session(
            session_id, visitor_id, body.platform, source_id, lang,
            is_automated_ua(user_agent), bool(body.test), now,
        )
        if not created:
            existing = store.get_session(session_id)
            if existing is None or existing["visitor_id"] != visitor_id:
                raise HTTPException(409, "session conflict")
        # deterministic id: a repeated call never records a second open event
        try:
            store.add_events(session_id, visitor_id, body.platform, [{
                "event_id": str(uuid.uuid5(_OPEN_NS, f"{session_id}:{open_event}")),
                "name": open_event, "ts": now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "props": {},
            }])
        except SessionGone:
            raise HTTPException(410, "session gone") from None
        return {"token": self.make_token(session_id, visitor_id), "visitor_id": visitor_id}

    def add_events(self, body: EventsIn) -> tuple[int, dict]:
        if not is_uuid(body.session_id):
            return 400, {"detail": "invalid session_id"}
        session_id = body.session_id.lower()
        session = self.store.get_session(session_id)
        if session is None or not hex_equal(body.token, self.make_token(session_id, session["visitor_id"])):
            return 401, {"detail": "invalid token"}
        if len(body.events) > MAX_EVENTS:
            return 400, {"detail": "too many events"}
        now = self.now()
        valid, rejected = [], []
        seen: set[str] = set()
        for i, raw in enumerate(body.events):
            try:
                ev = validate_event(raw, now)
                if ev["name"] in SERVER_ONLY:
                    raise EventError("server-only event")
            except EventError as exc:
                rejected.append({"index": i, "error": str(exc)})
                continue
            if ev["event_id"] in seen:
                rejected.append({"index": i, "error": "duplicate in batch"})
                continue
            seen.add(ev["event_id"])
            valid.append(ev)
        accepted = duplicates = 0
        if valid:
            try:
                accepted, duplicates = self.store.add_events(
                    session_id, session["visitor_id"], session["platform"], valid)
            except SessionGone:  # deleted between validation and insert: nothing was written
                return 401, {"detail": "invalid token"}
            self.store.touch_session(session_id, now)
        status = 400 if rejected and not valid else 200
        return status, {"accepted": accepted, "duplicates": duplicates, "rejected": rejected}

    # ---- retention ------------------------------------------------------------------------
    def purge_once(self) -> int:
        cutoff = self.now() - timedelta(days=RETENTION_DAYS)
        deleted = self.store.purge_events_older_than(cutoff)
        log.info("analytics retention: %d events deleted", deleted)
        return deleted

    async def retention_loop(self) -> None:
        while True:
            try:
                await run_in_threadpool(self.purge_once)
            except Exception as exc:  # never kill the API because of housekeeping
                log.warning("analytics retention failed: %s", type(exc).__name__)
            await asyncio.sleep(24 * 3600)


async def read_body(request: Request, limit: int = MAX_BODY) -> bytes:
    """Whole body, 413 when larger than ``limit`` (Content-Length and actual bytes)."""
    cl = request.headers.get("content-length")
    if cl and cl.isdigit() and int(cl) > limit:
        raise HTTPException(413, "payload too large")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise HTTPException(413, "payload too large")
        chunks.append(chunk)
    return b"".join(chunks)


def _parse(model: type[BaseModel], raw: bytes):
    try:
        return model.model_validate(json.loads(raw))
    except (ValueError, ValidationError):
        raise HTTPException(400, "invalid request") from None


def make_admin_guard(svc: AnalyticsService) -> Callable[[Request], None]:
    """FastAPI dependency shared by all /api/admin routers: 404 when admin is off, 401 without a valid cookie."""

    def admin_guard(request: Request) -> None:
        if not svc.admin_enabled:
            raise HTTPException(404, "not found")
        if not svc.check_admin_cookie(request.cookies.get(ADMIN_COOKIE)):
            raise HTTPException(401, "unauthorized")

    return admin_guard


def build_router(svc: AnalyticsService) -> APIRouter:
    router = APIRouter()
    s = svc.settings

    # ---- public ---------------------------------------------------------------------------
    @router.post("/api/v1/analytics/session")
    async def session(request: Request) -> JSONResponse:
        if not s.analytics_enabled:
            raise HTTPException(404, "analytics disabled")
        raw = await read_body(request)
        if not svc.ip_limiter.allow(svc.ip(request)):
            raise HTTPException(429, "rate limited")
        body = _parse(SessionIn, raw)
        result = await run_in_threadpool(svc.create_session, body, request.headers.get("user-agent"))
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @router.post("/api/v1/analytics/events")
    async def events(request: Request) -> JSONResponse:
        if not s.analytics_enabled:
            raise HTTPException(404, "analytics disabled")
        raw = await read_body(request)
        if not svc.ip_limiter.allow(svc.ip(request)):
            raise HTTPException(429, "rate limited")
        body = _parse(EventsIn, raw)
        if not svc.session_limiter.allow(body.session_id.lower()):
            raise HTTPException(429, "rate limited")
        status, payload = await run_in_threadpool(svc.add_events, body)
        return JSONResponse(payload, status_code=status, headers={"Cache-Control": "no-store"})

    # ---- admin ----------------------------------------------------------------------------
    admin_guard = make_admin_guard(svc)

    @router.post("/api/admin/login")
    def login(body: LoginIn, request: Request) -> JSONResponse:
        if not svc.admin_enabled:
            raise HTTPException(404, "not found")
        ip = svc.ip(request)
        # reserve the attempt atomically BEFORE verifying: concurrent guesses cannot exceed the limit
        if not svc.login_limiter.allow(ip):
            raise HTTPException(429, "too many attempts")
        if not svc.password_ok(body.password):
            log.warning("admin login failed")
            raise HTTPException(401, "wrong password")
        svc.login_limiter.clear(ip)  # success policy: forget this IP's failed attempts
        resp = JSONResponse({"ok": True})
        resp.set_cookie(ADMIN_COOKIE, svc.make_admin_cookie(), max_age=ADMIN_TTL_S, httponly=True,
                        secure=s.admin_cookie_secure, samesite="strict", path="/api/admin")
        return resp

    @router.post("/api/admin/logout")
    def logout() -> JSONResponse:
        if not svc.admin_enabled:
            raise HTTPException(404, "not found")
        resp = JSONResponse({"ok": True})
        resp.delete_cookie(ADMIN_COOKIE, path="/api/admin", httponly=True,
                           secure=s.admin_cookie_secure, samesite="strict")
        return resp

    def get_filters(
        from_: str | None = Query(None, alias="from", max_length=10),
        to: str | None = Query(None, max_length=10),
        platform: str | None = Query(None, max_length=16),
        lang: str | None = Query(None, max_length=16),
        source_kind: str | None = Query(None, max_length=32),
        source: str | None = Query(None, max_length=64),
        campaign: str | None = Query(None, max_length=64),
        include_test: bool = False,
        include_automated: bool = False,
    ) -> Filters:
        return resolve_filters(from_, to, platform, lang, source_kind, source, campaign,
                               include_test, include_automated)

    def resolve_filters(from_, to, platform, lang, source_kind, source, campaign,
                        include_test, include_automated) -> Filters:
        today = svc.now().astimezone(s.tz).date()
        try:
            end = date.fromisoformat(to) if to else today
            start = date.fromisoformat(from_) if from_ else end - timedelta(days=6)
        except ValueError:
            raise HTTPException(400, "invalid date") from None
        if start > end or (end - start).days > MAX_PERIOD_DAYS:
            raise HTTPException(400, "invalid period")
        return Filters(start, end, dict(
            platform=platform, lang=lang, source_kind=source_kind, source=source, campaign=campaign,
            include_test=include_test, include_automated=include_automated))

    @router.get("/api/admin/metrics", dependencies=[Depends(admin_guard)])
    def metrics(f: Filters = Depends(get_filters)) -> JSONResponse:
        return JSONResponse(svc.store.metrics(f.start, f.end, **f.kw))

    @router.get("/api/admin/users", dependencies=[Depends(admin_guard)])
    def users(f: Filters = Depends(get_filters),
              limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)) -> JSONResponse:
        # no search text here: it would end up in URLs and access logs (use POST /users/search)
        return JSONResponse(svc.store.users(f.start, f.end, limit=limit, offset=offset, **f.kw))

    @router.post("/api/admin/users/search", dependencies=[Depends(admin_guard)])
    def users_search(body: UsersSearchIn) -> JSONResponse:
        f = resolve_filters(
            body.from_, body.to, body.platform, body.lang, body.source_kind, body.source, body.campaign,
            body.include_test, body.include_automated)
        return JSONResponse(svc.store.users(f.start, f.end, q=body.q, limit=body.limit, offset=body.offset, **f.kw))

    @router.get("/api/admin/filters", dependencies=[Depends(admin_guard)])
    def filters() -> JSONResponse:
        return JSONResponse(svc.store.filters())

    @router.get("/api/admin/users/{visitor_id}", dependencies=[Depends(admin_guard)])
    def user_card(visitor_id: str) -> JSONResponse:
        card = svc.store.user_card(visitor_id)
        if card is None:
            raise HTTPException(404, "not found")
        return JSONResponse(card)

    @router.delete("/api/admin/users/{visitor_id}", dependencies=[Depends(admin_guard)])
    def delete_user(visitor_id: str) -> JSONResponse:
        if not svc.store.delete_visitor(visitor_id):
            raise HTTPException(404, "not found")
        return JSONResponse({"ok": True})

    return router
