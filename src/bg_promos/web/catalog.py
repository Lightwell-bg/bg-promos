"""Public catalog: built from the last successful run of every enabled chain.

``CatalogCache`` rebuilds the payload only when its key changes: the id of the
last successful (and last finished) run per chain, today's date in
Europe/Sofia and the current UTC hour (time-based ``stale`` flags). Checking the key is one tiny query per chain on a short-lived
read-only connection.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any

from ..config import Settings
from ..export import chain_status
from ..storage import Storage
from .categories import CATEGORIES, classify
from .db import read_storage
from .pricing import _condition, derive

log = logging.getLogger(__name__)

CATALOG_VERSION = 1
STALE_DB_REASON = "database unavailable"
CHAIN_NAMES ={"lidl": "Lidl", "kaufland": "Kaufland", "billa": "BILLA"}

# (run ids per chain, Sofia date, current UTC hour "YYYY-MM-DDTHH"). The hour makes
# time-based chain ``stale`` flags refresh at least hourly.
CacheKey = tuple[tuple[tuple[int, int], ...], str, str]


def _utc_hour(now: datetime) -> str:
    return _aware(now).astimezone(timezone.utc).strftime("%Y-%m-%dT%H")


def _aware(now: datetime | None) -> datetime:
    if now is None:
        return datetime.now(timezone.utc)
    return now.replace(tzinfo=timezone.utc) if now.tzinfo is None else now


def enabled_chains(settings: Settings) -> list[str]:
    return sorted(n for n, cs in settings.chains.items() if cs.enabled)


def offer_id(chain: str, source_key: str, valid_from: str | None, valid_to: str | None) -> str:
    raw = f"{chain}|{source_key}|{valid_from or ''}|{valid_to or ''}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def _run_ids(storage: Storage, chains: list[str]) -> tuple[tuple[int, int], ...]:
    """(last ok run id, last finished run id) per chain; 0 when none."""
    out = []
    for chain in chains:
        row = storage.conn.execute(
            "SELECT "
            "(SELECT COALESCE(MAX(id), 0) FROM scrape_runs WHERE chain = ?1 AND status = 'ok'), "
            "(SELECT COALESCE(MAX(id), 0) FROM scrape_runs WHERE chain = ?1 AND status != 'running')",
            (chain,),
        ).fetchone()
        out.append((int(row[0]), int(row[1])))
    return tuple(out)


def _public_offer(settings: Settings, row: dict[str, Any]) -> dict[str, Any]:
    chain = row["chain"]
    name = row["name"]
    lowered = name.lower()
    description = row["description"] if lowered.startswith(("на ", "за ")) else None
    derived = derive(row["prices"], row["unit_text"], name)
    regular = derived["regular_cents"]
    product_url = row["product_url"] or None
    source_url = product_url or settings.offers_urls.get(chain) or settings.brochure_urls.get(chain) or ""
    return {
        "id": offer_id(chain, row["source_key"], row["valid_from"], row["valid_to"]),
        "chain": chain,
        "product_ref": row["product_ref"],
        "name": name,
        "brand": row["brand"],
        "description": row["description"],
        "category": classify(chain, row["category"], name, description),
        "chain_category": row["category"] or None,
        "unit_text": row["unit_text"],
        "label": row["offer_label"],
        "image_url": row["image_url"],
        "source_url": source_url,
        "source_is_product": bool(product_url),
        "valid_from": row["valid_from"],
        "valid_to": row["valid_to"],
        "first_seen_at": row["first_seen_at"],
        "prices": [_condition(p, regular) for p in row["prices"]],
        "best": derived["best"],
        "no_card": derived["no_card"],
        "regular_cents": regular,
        "savings_per_item_cents": derived["savings_per_item_cents"],
        "unit_price": derived["unit_price"],
    }


def chains_block(storage: Storage, settings: Settings, now: datetime) -> dict[str, dict[str, Any]]:
    now_utc = _aware(now).astimezone(timezone.utc)
    block: dict[str, dict[str, Any]] = {}
    for chain in enabled_chains(settings):
        info = chain_status(storage, settings, chain, now_utc)
        info["name"] = CHAIN_NAMES.get(chain, chain.title())
        info["offers_url"] = settings.offers_urls.get(chain)
        info["brochure_url"] = settings.brochure_urls.get(chain)
        block[chain] = info
    return block


def _build(settings: Settings, now: datetime) -> tuple[dict[str, Any], CacheKey]:
    """Build the catalog inside one read snapshot; returns (catalog, cache key of that snapshot)."""
    now = _aware(now)
    local_now = now.astimezone(settings.tz)
    today = local_now.date().isoformat()
    chains = enabled_chains(settings)
    with read_storage(settings.db_path) as storage:
        storage.conn.execute("BEGIN")  # one consistent WAL snapshot for all reads below
        try:
            key: CacheKey = (_run_ids(storage, chains), today, _utc_hour(now))
            offers: list[dict[str, Any]] = []
            for chain in chains:
                for row in storage.offers_of_last_success(chain):
                    if row["valid_to"] is not None and row["valid_to"] < today:
                        continue  # expired
                    offers.append(_public_offer(settings, row))
            block = chains_block(storage, settings, now)
        finally:
            storage.conn.rollback()
    offers.sort(key=lambda o: (o["chain"], o["name"], o["id"]))
    catalog = {
        "version": CATALOG_VERSION,
        "generated_at": local_now.isoformat(timespec="seconds"),
        "today": today,
        "currency": "EUR",
        "chains": block,
        "categories": [{"id": c[0], "bg": c[1], "ru": c[2], "icon": c[3]} for c in CATEGORIES],
        "offers": offers,
    }
    return catalog, key


def build_catalog(settings: Settings, now: datetime | None = None) -> dict[str, Any]:
    return _build(settings, _aware(now))[0]


def build_meta(settings: Settings, now: datetime | None = None) -> dict[str, Any]:
    now = _aware(now)
    local_now = now.astimezone(settings.tz)
    with read_storage(settings.db_path) as storage:
        block = chains_block(storage, settings, now)
    return {
        "generated_at": local_now.isoformat(timespec="seconds"),
        "today": local_now.date().isoformat(),
        "chains": block,
    }


def _content_hash(catalog: dict[str, Any]) -> str:
    """Hash of the catalog without ``generated_at`` (which changes on every rebuild)."""
    body = {k: v for k, v in catalog.items() if k != "generated_at"}
    raw = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha1(raw).hexdigest()


def _etag(content_hash: str) -> str:
    return '"' + content_hash[:20] + '"'


class CatalogCache:
    """Thread-safe cache of (json bytes, gzip bytes, etag), rebuilt when the key changes."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._lock = threading.Lock()
        self._key: CacheKey | None = None
        self._value: tuple[bytes, bytes, str] | None = None
        self._content_hash: str | None = None
        self._fallback: tuple[tuple[str | None, str], tuple[bytes, bytes, str]] | None = None

    def current_key(self, now: datetime) -> CacheKey:
        chains = enabled_chains(self.settings)
        today = _aware(now).astimezone(self.settings.tz).date().isoformat()
        with read_storage(self.settings.db_path) as storage:
            return (_run_ids(storage, chains), today, _utc_hour(now))

    def _degraded(self, now: datetime) -> tuple[bytes, bytes, str]:
        """Copy of the last good payload with every chain marked stale and a new ETag.

        Called with the lock held and ``self._value`` set. The good value itself is left
        untouched, so a recovered database is served normally again.
        """
        today = now.astimezone(self.settings.tz).date().isoformat()
        stamp = (self._content_hash, today)
        if self._fallback is not None and self._fallback[0] == stamp:
            return self._fallback[1]
        catalog = json.loads(self._value[0])
        catalog["today"] = today
        for info in catalog.get("chains", {}).values():
            info["stale"] = True
            info["stale_reason"] = STALE_DB_REASON
        payload = json.dumps(catalog, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        value = (payload, gzip.compress(payload, compresslevel=6, mtime=0), _etag(hashlib.sha1(payload).hexdigest()))
        self._fallback = (stamp, value)
        return value

    def get(self, now: datetime | None = None) -> tuple[bytes, bytes, str]:
        now = _aware(now)
        with self._lock:
            try:
                key = self.current_key(now)
                if self._value is not None and key == self._key:
                    return self._value
                catalog, key = _build(self.settings, now)
            except sqlite3.Error:
                if self._value is not None:
                    log.exception("catalog rebuild failed; serving the previous copy marked stale")
                    return self._degraded(now)
                raise
            content_hash = _content_hash(catalog)
            if self._value is not None and content_hash == self._content_hash:
                # Same content as before: keep bytes and ETag so ``generated_at`` is the
                # time the content last changed and clients keep getting 304.
                self._key = key
                return self._value
            payload = json.dumps(catalog, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self._value = (payload, gzip.compress(payload, compresslevel=6, mtime=0), _etag(content_hash))
            self._key = key
            self._content_hash = content_hash
            log.info(
                "catalog rebuilt: %d offers, %d bytes (gzip %d), key=%s",
                len(catalog["offers"]), len(payload), len(self._value[1]), key,
            )
            return self._value
