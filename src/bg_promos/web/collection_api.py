"""Admin API "Сбор данных": per-chain run statistics, schedule overrides and "collect now" requests.

Admin edits live in data/control.sqlite3 (ControlStore) and never touch config.ini; the catalog
database is only read, through the read-only connection. Every SQLite call runs in the thread pool.
Validation errors answer 422 (the app-wide RequestValidationError handler would turn FastAPI's own
into 400, so bodies and query values are checked by hand here).
"""

from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from ..control import (
    ChainSchedule,
    ControlStore,
    StaleRevisionError,
    effective_schedule,
    format_slots,
    validate_schedule,
)
from ..pipeline import CHAINS, next_slot_instant
from .analytics_api import AnalyticsService, make_admin_guard, read_body
from .db import read_storage

log = logging.getLogger(__name__)

PERIOD_DAYS = (7, 30, 90)
SERIES_CAP = 500
RECENT_CAP = 100
ERROR_MAX = 300
CRON_TEXT = "hourly at :00"


def _utc(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        d = datetime.fromisoformat(ts)
    except ValueError:
        return None
    return (d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d).astimezone(timezone.utc)


def _iso(d: datetime | None) -> str | None:
    return d.astimezone(timezone.utc).isoformat(timespec="seconds") if d else None


def _duration(row: sqlite3.Row) -> float | None:
    a, b = _utc(row["started_at"]), _utc(row["finished_at"])
    return round((b - a).total_seconds(), 1) if a and b else None


def _run_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"], "started_at": row["started_at"], "finished_at": row["finished_at"],
        "status": row["status"], "scheduled": bool(row["scheduled"]),
        "offers_count": row["offers_count"], "active_count": row["active_count"],
        "error": row["error"], "duration_s": _duration(row),
    }


def _schedule_dict(s: ChainSchedule) -> dict:
    return {
        "enabled": s.enabled, "slots": format_slots(s.slots), "source": s.source,
        "revision": s.revision, "updated_at": s.updated_at,
    }


def _req_dict(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    return {"id": row["id"], "requested_at": row["requested_at"], "claimed_at": row["claimed_at"],
            "finished_at": row["finished_at"], "status": row["status"], "run_id": row["run_id"]}


def _open_control(path) -> ControlStore | None:
    try:
        return ControlStore(path)
    except Exception:
        log.exception("control DB unavailable")
        return None


def _period_stats(rows: list[sqlite3.Row]) -> dict:
    ok = [r for r in rows if r["status"] == "ok"]
    finished = [r for r in rows if r["status"] != "running"]
    durations = [d for d in (_duration(r) for r in finished) if d is not None]
    counts = [r["offers_count"] for r in ok if r["offers_count"] is not None]
    suspicious = sum(r["status"] == "suspicious" for r in rows)
    failed = sum(r["status"] == "failed" for r in rows)
    return {
        "runs": len(rows), "ok": len(ok), "suspicious": suspicious, "failed": failed,
        "running": len(rows) - len(finished),
        "success_rate": round(len(ok) / len(finished), 4) if finished else None,
        "avg_duration_s": round(sum(durations) / len(durations), 1) if durations else None,
        "avg_offers": round(sum(counts) / len(counts), 1) if counts else None,
    }


def build_collection_router(svc: AnalyticsService) -> APIRouter:
    router = APIRouter()
    s = svc.settings
    guard = [Depends(make_admin_guard(svc))]

    def check_chain(chain: str) -> None:
        if chain not in CHAINS:
            raise HTTPException(404, "unknown chain")
        if not s.chain(chain).enabled:
            raise HTTPException(409, "chain is disabled in config.ini")

    def need_control() -> ControlStore:
        control = _open_control(s.control_db_path)
        if control is None:
            raise HTTPException(503, "control database unavailable")
        return control

    # ---- statistics -----------------------------------------------------------------------
    def collect_stats(days: int, chain_filter: str | None) -> dict:
        now = svc.now().astimezone(timezone.utc)
        cutoff = _iso(now - timedelta(days=days))
        control = _open_control(s.control_db_path)
        per_chain: dict[str, dict[str, Any]] = {c: {"rows": [], "last": None, "last_ok": None} for c in CHAINS}
        recent: list[dict] = []
        try:
            with read_storage(s.db_path) as storage:
                for c in CHAINS:
                    q = storage.conn.execute
                    rows = q("SELECT * FROM scrape_runs WHERE chain = ? AND started_at >= ? ORDER BY started_at DESC, id DESC LIMIT ?",
                             (c, cutoff, 100000)).fetchall()
                    per_chain[c]["rows"] = list(reversed(rows))
                    per_chain[c]["last"] = q(
                        "SELECT * FROM scrape_runs WHERE chain = ? ORDER BY started_at DESC, id DESC LIMIT 1", (c,)).fetchone()
                    per_chain[c]["last_ok"] = q(
                        "SELECT finished_at FROM scrape_runs WHERE chain = ? AND status = 'ok' "
                        "ORDER BY started_at DESC, id DESC LIMIT 1", (c,)).fetchone()
                if chain_filter:
                    cur = storage.conn.execute(
                        "SELECT * FROM scrape_runs WHERE chain = ? ORDER BY started_at DESC, id DESC LIMIT ?",
                        (chain_filter, RECENT_CAP))
                else:
                    cur = storage.conn.execute("SELECT * FROM scrape_runs ORDER BY started_at DESC, id DESC LIMIT ?", (RECENT_CAP,))
                for r in cur.fetchall():
                    recent.append({
                        "id": r["id"], "chain": r["chain"], "started_at": r["started_at"],
                        "finished_at": r["finished_at"], "status": r["status"], "scheduled": bool(r["scheduled"]),
                        "offers_count": r["offers_count"], "active_count": r["active_count"],
                        "content_changed": None if r["content_changed"] is None else bool(r["content_changed"]),
                        "error": (r["error"] or None) and r["error"][:ERROR_MAX],
                        "duration_s": _duration(r),
                    })
        except sqlite3.Error:
            log.warning("catalog DB unreadable for collection stats", exc_info=True)
            recent = []
        try:
            chains = []
            for c in CHAINS:
                config_enabled = s.chain(c).enabled
                try:
                    sched = effective_schedule(s, control, c)
                except Exception:
                    log.exception("%s: cannot compute effective schedule", c)
                    sched = ChainSchedule(True, tuple(s.slots), "config", 0, None)
                nxt = next_slot_instant(sched.slots, s.tz, now) if config_enabled and sched.enabled else None
                data = per_chain[c]
                last_ok_at = data["last_ok"]["finished_at"] if data["last_ok"] else None
                ok_dt = _utc(last_ok_at)
                stale = ok_dt is None or now - ok_dt > timedelta(hours=s.stale_after_hours)
                pending = last_req = None
                if control is not None:
                    try:
                        pending, last_req = control.pending_request(c), control.last_request(c)
                    except sqlite3.Error:
                        log.exception("%s: cannot read collect requests", c)
                chains.append({
                    "chain": c, "config_enabled": config_enabled,
                    "schedule": _schedule_dict(sched),
                    "config_slots": format_slots(s.slots),
                    "next_slot_at": _iso(nxt),
                    "last_run": _run_dict(data["last"]) if data["last"] else None,
                    "last_ok_at": last_ok_at, "stale": stale,
                    "period": _period_stats(data["rows"]),
                    "pending_request": (
                        {"id": pending["id"], "requested_at": pending["requested_at"]} if pending else None),
                    "last_request": (
                        {"requested_at": last_req["requested_at"], "claimed_at": last_req["claimed_at"],
                         "finished_at": last_req["finished_at"], "status": last_req["status"]}
                        if last_req else None),
                    "series": [
                        {"started_at": r["started_at"], "status": r["status"],
                         "offers_count": r["offers_count"], "active_count": r["active_count"]}
                        for r in data["rows"][-SERIES_CAP:]
                    ],
                })
        finally:
            if control is not None:
                control.close()
        return {"now": _iso(now), "tz": s.timezone, "cron": CRON_TEXT, "chains": chains, "recent_runs": recent}

    @router.get("/api/admin/collection", dependencies=guard)
    async def collection(days: str = "7", chain: str | None = None) -> JSONResponse:
        if days not in {str(d) for d in PERIOD_DAYS}:
            raise HTTPException(422, "days must be 7, 30 or 90")
        if chain is not None and chain not in CHAINS:
            raise HTTPException(404, "unknown chain")
        return JSONResponse(await run_in_threadpool(collect_stats, int(days), chain))

    # ---- schedule -------------------------------------------------------------------------
    def stale_response(chain: str, control: ControlStore, exc: StaleRevisionError) -> JSONResponse:
        current = _schedule_dict(effective_schedule(s, control, chain))
        return JSONResponse({"detail": "stale", "current": current}, status_code=409)

    def save(chain: str, enabled: bool, slots: list[str], revision: int) -> JSONResponse:
        parsed = validate_schedule(enabled, slots)
        control = need_control()
        try:
            try:
                control.save_schedule(chain, enabled, parsed, revision)
            except StaleRevisionError as exc:
                return stale_response(chain, control, exc)
            log.info("admin schedule for %s: enabled=%s slots=%s", chain, enabled, ",".join(format_slots(parsed)))
            return JSONResponse(_schedule_dict(effective_schedule(s, control, chain)))
        finally:
            control.close()

    @router.put("/api/admin/collection/schedule/{chain}", dependencies=guard)
    async def put_schedule(chain: str, request: Request) -> JSONResponse:
        check_chain(chain)
        try:
            body = json.loads(await read_body(request, 8 * 1024))
        except ValueError:
            raise HTTPException(422, "invalid JSON") from None
        if not isinstance(body, dict):
            raise HTTPException(422, "invalid body")
        enabled, slots, revision = body.get("enabled"), body.get("slots"), body.get("revision")
        if (not isinstance(enabled, bool) or not isinstance(slots, list)
                or not isinstance(revision, int) or isinstance(revision, bool) or revision < 0):
            raise HTTPException(422, "expected {enabled: bool, slots: [HH:MM], revision: int}")
        try:
            return await run_in_threadpool(save, chain, enabled, slots, revision)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None

    def reset(chain: str, revision: int) -> JSONResponse:
        control = need_control()
        try:
            try:
                control.reset_schedule(chain, revision)
            except StaleRevisionError as exc:
                return stale_response(chain, control, exc)
            log.info("admin schedule for %s reset to config.ini", chain)
            return JSONResponse(_schedule_dict(effective_schedule(s, control, chain)))
        finally:
            control.close()

    @router.delete("/api/admin/collection/schedule/{chain}", dependencies=guard)
    async def delete_schedule(chain: str, revision: str = "") -> JSONResponse:
        check_chain(chain)
        if not (revision.isascii() and revision.isdigit()):
            raise HTTPException(422, "revision must be a non-negative integer")
        return await run_in_threadpool(reset, chain, int(revision))

    # ---- "collect now" --------------------------------------------------------------------
    def queue(chain: str) -> JSONResponse:
        control = need_control()
        try:
            row, created = control.request_run(chain, svc.now())
        finally:
            control.close()
        if created:
            log.info("admin requested a manual collection of %s", chain)
        return JSONResponse(
            {"request": {"id": row["id"], "requested_at": row["requested_at"]}, "created": created},
            status_code=202 if created else 200,
        )

    @router.post("/api/admin/collection/run/{chain}", dependencies=guard)
    async def run_now(chain: str) -> JSONResponse:
        check_chain(chain)
        return await run_in_threadpool(queue, chain)

    return router
