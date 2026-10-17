"""JSON export of the last successful run of every enabled chain."""

from __future__ import annotations

import json
import logging
import os
import tempfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .config import Settings
from .storage import Storage

log = logging.getLogger(__name__)

BGN_RATE = 1.95583  # informational only; all prices are EUR


def _now_utc(now: datetime | None) -> datetime:
    if now is None:
        return datetime.now(timezone.utc)
    return now.replace(tzinfo=timezone.utc) if now.tzinfo is None else now.astimezone(timezone.utc)


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    dt = datetime.fromisoformat(value)
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def best_price(prices: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Cheapest per-unit condition among promo/loyalty/multibuy; regular only when none of those exist."""
    candidates = [p for p in prices if p["kind"] in ("promo", "loyalty", "multibuy")]
    if not candidates:
        candidates = [p for p in prices if p["kind"] == "regular"][:1]
    if not candidates:
        return None
    best = min(candidates, key=lambda p: p["price_cents"] / max(p["min_qty"], 1))
    qty = max(best["min_qty"], 1)
    return {
        "kind": best["kind"],
        "program": best["program"],
        "min_qty": best["min_qty"],
        "price_cents": best["price_cents"],
        "unit_price_cents": round(best["price_cents"] / qty),
        "discount_pct": best["discount_pct"],
    }


def public_offer(row: dict[str, Any]) -> dict[str, Any]:
    """Shape one stored offer for the JSON files (plain strings only, no HTML)."""
    prices = row["prices"]

    def first(kind: str) -> dict[str, Any] | None:
        return next((p for p in prices if p["kind"] == kind), None)

    promo, regular, loyalty = first("promo"), first("regular"), first("loyalty")
    return {
        "chain": row["chain"],
        "product_ref": row["product_ref"],
        "source_key": row["source_key"],
        "name": row["name"],
        "brand": row["brand"],
        "description": row["description"],
        "category": row["category"],
        "unit_text": row["unit_text"],
        "offer_label": row["offer_label"],
        "valid_from": row["valid_from"],
        "valid_to": row["valid_to"],
        "image_url": row["image_url"],
        "product_url": row["product_url"],
        "prices": prices,
        "price_cents": promo["price_cents"] if promo else None,
        "regular_price_cents": regular["price_cents"] if regular else None,
        "discount_pct": promo["discount_pct"] if promo else None,
        "loyalty_price_cents": loyalty["price_cents"] if loyalty else None,
        "loyalty_program": loyalty["program"] if loyalty else None,
        "best_price": best_price(prices),
    }


def _sort_key(o: dict[str, Any]) -> tuple:
    return (o["chain"], o["name"] or "", o["source_key"], o["valid_from"] or "", o["valid_to"] or "")


def split_offers(rows: list[dict[str, Any]], today: date) -> tuple[list[dict], list[dict]]:
    """Split stored offers into (current, upcoming) by ``today``; expired offers are dropped."""
    today_s = today.isoformat()
    current, upcoming = [], []
    for row in rows:
        vf, vt = row["valid_from"], row["valid_to"]
        if vt is not None and vt < today_s:
            continue
        (upcoming if vf is not None and vf > today_s else current).append(public_offer(row))
    return current, upcoming


def chain_status(storage: Storage, settings: Settings, chain: str, now_utc: datetime) -> dict[str, Any]:
    last = storage.last_run(chain)
    ok_at = storage.last_success_at(chain)
    reasons = []
    if ok_at is None:
        reasons.append("never succeeded")
    elif (now_utc - _parse_ts(ok_at)) > timedelta(hours=settings.stale_after_hours):
        reasons.append(f"last success older than {settings.stale_after_hours:g} h")
    if last is not None and last["status"] != "ok":
        detail = f": {last['error']}" if last["error"] else ""
        reasons.append(f"last run {last['status']}{detail}")
    return {
        "status": last["status"] if last else "never",
        "last_run_at": last["finished_at"] if last else None,
        "last_success_at": ok_at,
        "stale": bool(reasons),
        "stale_reason": "; ".join(reasons) or None,
    }


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.chmod(tmp, 0o644)  # mkstemp creates 0600; the web server must be able to read the file
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def export_all(storage: Storage, settings: Settings, now: datetime | None = None) -> dict[str, Path]:
    """Write offers_current.json, offers_upcoming.json and <chain>.json; returns written paths."""
    now_utc = _now_utc(now)
    local_now = now_utc.astimezone(settings.tz)
    today = local_now.date()
    out_dir = settings.data_dir / "export"

    per_chain: dict[str, tuple[list[dict], list[dict]]] = {}
    meta_chains: dict[str, dict[str, Any]] = {}
    for chain, cs in settings.chains.items():
        if not cs.enabled:
            continue
        current, upcoming = split_offers(storage.offers_of_last_success(chain), today)
        per_chain[chain] = (current, upcoming)
        info = chain_status(storage, settings, chain, now_utc)
        dates_from = [o["valid_from"] for o in current + upcoming if o["valid_from"]]
        dates_to = [o["valid_to"] for o in current + upcoming if o["valid_to"]]
        info.update(
            offers_current=len(current),
            offers_upcoming=len(upcoming),
            valid_from_min=min(dates_from) if dates_from else None,
            valid_to_max=max(dates_to) if dates_to else None,
        )
        meta_chains[chain] = info

    def meta(names: list[str]) -> dict[str, Any]:
        return {
            "generated_at": local_now.isoformat(timespec="seconds"),
            "currency": "EUR",
            "timezone": settings.timezone,
            "bgn_rate": BGN_RATE,
            "chains": {n: meta_chains[n] for n in names},
        }

    names = sorted(per_chain)
    all_current = sorted((o for n in names for o in per_chain[n][0]), key=_sort_key)
    all_upcoming = sorted((o for n in names for o in per_chain[n][1]), key=_sort_key)
    written = {
        "current": out_dir / "offers_current.json",
        "upcoming": out_dir / "offers_upcoming.json",
    }
    write_json_atomic(written["current"], {"meta": meta(names), "offers": all_current})
    write_json_atomic(written["upcoming"], {"meta": meta(names), "offers": all_upcoming})
    for n in names:
        path = out_dir / f"{n}.json"
        offers = sorted(per_chain[n][0] + per_chain[n][1], key=_sort_key)
        write_json_atomic(path, {"meta": meta([n]), "offers": offers})
        written[n] = path
    log.info("export: %s", {n: (len(per_chain[n][0]), len(per_chain[n][1])) for n in names})
    return written
