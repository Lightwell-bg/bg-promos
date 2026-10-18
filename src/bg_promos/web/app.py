"""Public read-only HTTP API for the PWA (see docs/API.md).

Endpoints are plain ``def`` so FastAPI runs them in a worker thread: the
catalog rebuild (SQLite + JSON + gzip) must not block the event loop.
The API never writes to the catalog database (analytics has its own SQLite file).
"""

from __future__ import annotations

import asyncio
import logging
import re
import sqlite3
from collections.abc import Callable
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from ..config import Settings, load
from .analytics_api import AnalyticsService, build_router, install_access_log_filter
from .catalog import CatalogCache, build_meta
from .db import db_available
from .report import ReportIn, ReportService

log = logging.getLogger(__name__)

JSON_TYPE = "application/json; charset=utf-8"


def accepts_gzip(header: str | None) -> bool:
    if not header:
        return False
    for part in header.split(","):
        token, _, params = part.strip().partition(";")
        if token.strip().lower() not in ("gzip", "x-gzip"):
            continue
        m = re.search(r"q\s*=\s*([0-9.]+)", params)
        try:
            return float(m.group(1)) > 0 if m else True
        except ValueError:
            return True
    return False


def etag_matches(if_none_match: str | None, etag: str) -> bool:
    if not if_none_match:
        return False
    if if_none_match.strip() == "*":
        return True
    wanted = etag.removeprefix("W/")
    return any(c.strip().removeprefix("W/") == wanted for c in if_none_match.split(","))


def create_app(
    settings: Settings | None = None,
    report_service: ReportService | None = None,
    now_fn: Callable[[], datetime] | None = None,
) -> FastAPI:
    settings = settings or load()
    logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    now =now_fn or (lambda: datetime.now(timezone.utc))
    cache = CatalogCache(settings)
    reports = report_service or ReportService(settings)

    analytics = AnalyticsService(settings, now_fn=now_fn)
    install_access_log_filter()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        install_access_log_filter()  # idempotent; survives uvicorn's logging setup
        task = asyncio.create_task(analytics.retention_loop()) if settings.analytics_enabled else None
        try:
            yield
        finally:
            if task:
                task.cancel()

    app = FastAPI(title="BG Promos API", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.settings = settings
    app.state.cache = cache
    app.state.reports = reports
    app.state.analytics = analytics
    app.include_router(build_router(analytics))

    @app.middleware("http")
    async def admin_no_store(request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/api/admin"):
            response.headers["Cache-Control"] = "no-store"
        return response

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_methods=["GET", "HEAD", "POST"],
        allow_headers=["Content-Type", "If-None-Match"],
        expose_headers=["ETag"],
    )

    @app.exception_handler(RequestValidationError)
    def invalid_request(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse({"detail": "invalid request"}, status_code=400)

    @app.api_route("/api/health", methods=["GET", "HEAD"])
    def health() -> JSONResponse:
        ok = db_available(settings.db_path)
        return JSONResponse({"status": "ok" if ok else "error", "db": ok}, status_code=200 if ok else 503)

    @app.get("/api/v1/catalog")
    def catalog(request: Request) -> Response:
        try:
            payload, gz, etag = cache.get(now())
        except sqlite3.Error:
            log.exception("catalog unavailable")
            return JSONResponse({"detail": "catalog unavailable"}, status_code=503)
        headers = {"ETag": etag, "Cache-Control": "no-cache", "Vary": "Accept-Encoding"}
        if etag_matches(request.headers.get("if-none-match"), etag):
            return Response(status_code=304, headers=headers)
        if accepts_gzip(request.headers.get("accept-encoding")):
            return Response(gz, media_type=JSON_TYPE, headers={**headers, "Content-Encoding": "gzip"})
        return Response(payload, media_type=JSON_TYPE, headers=headers)

    @app.api_route("/api/v1/meta", methods=["GET", "HEAD"])
    def meta() -> JSONResponse:
        try:
            body = build_meta(settings, now())
        except sqlite3.Error:
            log.exception("meta unavailable")
            return JSONResponse({"detail": "database unavailable"}, status_code=503)
        return JSONResponse(body, headers={"Cache-Control": "no-cache"})

    @app.get("/api/v1/config")
    def config() -> JSONResponse:
        return JSONResponse(
            {
                "ga4_id": settings.ga4_id or None,
                "clarity_id": settings.clarity_id or None,
                "analytics_enabled": settings.analytics_enabled,
                "contact_email": settings.contact_email,
                "operator": settings.operator,
                "site_url": settings.site_url,
                "brochures": dict(settings.brochure_urls),
                "report_enabled": reports.enabled,
                "telegram_bot": settings.bot_username or None,
            },
            headers={"Cache-Control": "no-cache"},
        )

    @app.post("/api/v1/report")
    def report(body: ReportIn, request: Request) -> JSONResponse:
        peer = request.client.host if request.client else None
        ip = reports.client_ip(peer, request.headers.get("x-forwarded-for"))
        result = reports.handle(body, ip)
        return JSONResponse(result.body, status_code=result.status)

    return app


app = create_app()
