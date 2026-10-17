"""SQLite storage: products, offers, price conditions, price history, run log.

Identity model:
- ``products``  - one row per (chain, product_ref): the same goods across
  different promo periods. Price history hangs off this id.
- ``offers``    - one row per (chain, source_key, valid_from, valid_to): one
  promo listing of a product in one validity window.
- ``offer_prices`` - current price conditions of an offer (replaced on update).
- ``price_observations`` - append-only history; a row is written when a
  condition is first seen or its price changes.
- ``scrape_runs`` - one row per chain per run; offers carry ``last_seen_run``,
  so "what the last successful run saw" is a plain query.

Unknown dates are stored as '' (not NULL) so the UNIQUE constraint holds.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from .models import Offer, PriceCondition

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS scrape_runs (
    id            INTEGER PRIMARY KEY,
    chain         TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    status        TEXT NOT NULL DEFAULT 'running',  -- running | ok | suspicious | failed
    scheduled     INTEGER NOT NULL DEFAULT 0,
    offers_count  INTEGER,
    content_hash  TEXT,
    content_changed INTEGER,
    error         TEXT
);
CREATE INDEX IF NOT EXISTS ix_runs_chain ON scrape_runs(chain, id);

CREATE TABLE IF NOT EXISTS products (
    id            INTEGER PRIMARY KEY,
    chain         TEXT NOT NULL,
    product_ref   TEXT NOT NULL,
    name          TEXT NOT NULL,
    brand         TEXT,
    category      TEXT,
    unit_text     TEXT,
    image_url     TEXT,
    product_url   TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    UNIQUE (chain, product_ref)
);

CREATE TABLE IF NOT EXISTS offers (
    id            INTEGER PRIMARY KEY,
    chain         TEXT NOT NULL,
    source_key    TEXT NOT NULL,
    product_id    INTEGER NOT NULL REFERENCES products(id),
    name          TEXT NOT NULL,
    brand         TEXT,
    description   TEXT,
    category      TEXT,
    unit_text     TEXT,
    offer_label   TEXT,
    valid_from    TEXT NOT NULL DEFAULT '',
    valid_to      TEXT NOT NULL DEFAULT '',
    image_url     TEXT,
    product_url   TEXT,
    raw_json      TEXT,
    first_seen_run INTEGER NOT NULL REFERENCES scrape_runs(id),
    last_seen_run  INTEGER NOT NULL REFERENCES scrape_runs(id),
    first_seen_at TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    UNIQUE (chain, source_key, valid_from, valid_to)
);
CREATE INDEX IF NOT EXISTS ix_offers_seen ON offers(chain, last_seen_run);
CREATE INDEX IF NOT EXISTS ix_offers_product ON offers(product_id);

CREATE TABLE IF NOT EXISTS offer_prices (
    id            INTEGER PRIMARY KEY,
    offer_id      INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,      -- regular | promo | loyalty | multibuy
    program       TEXT NOT NULL DEFAULT '',
    min_qty       INTEGER NOT NULL DEFAULT 1,
    price_cents   INTEGER NOT NULL,   -- amount for min_qty units, EUR cents
    discount_pct  INTEGER,
    condition_text TEXT,
    UNIQUE (offer_id, kind, program, min_qty)
);

CREATE TABLE IF NOT EXISTS price_observations (
    id            INTEGER PRIMARY KEY,
    product_id    INTEGER NOT NULL REFERENCES products(id),
    offer_id      INTEGER NOT NULL REFERENCES offers(id),
    run_id        INTEGER NOT NULL REFERENCES scrape_runs(id),
    observed_at   TEXT NOT NULL,
    kind          TEXT NOT NULL,
    program       TEXT NOT NULL DEFAULT '',
    min_qty       INTEGER NOT NULL DEFAULT 1,
    price_cents   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_obs_offer ON price_observations(offer_id, kind, program, min_qty, id);
CREATE INDEX IF NOT EXISTS ix_obs_product ON price_observations(product_id, observed_at);
"""


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _d(v: date | None) -> str:
    return v.isoformat() if v else ""


class Storage:
    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        if self.path != ":memory:":
            self.conn.execute("PRAGMA journal_mode = WAL")
        self._migrate()

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> Storage:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def _migrate(self) -> None:
        version = self.conn.execute("PRAGMA user_version").fetchone()[0]
        if version < SCHEMA_VERSION:
            with self.conn:
                self.conn.executescript(SCHEMA)
                self.conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    # ---- runs -------------------------------------------------------------

    def start_run(self, chain: str, scheduled: bool = False) -> int:
        with self.conn:
            cur = self.conn.execute(
                "INSERT INTO scrape_runs (chain, started_at, scheduled) VALUES (?, ?, ?)",
                (chain, utcnow(), int(scheduled)),
            )
        return int(cur.lastrowid)

    def finish_run(
        self,
        run_id: int,
        status: str,
        offers_count: int | None = None,
        content_hash: str | None = None,
        error: str | None = None,
    ) -> None:
        row = self.conn.execute("SELECT chain FROM scrape_runs WHERE id = ?", (run_id,)).fetchone()
        changed = None
        if content_hash and row:
            prev = self.conn.execute(
                "SELECT content_hash FROM scrape_runs WHERE chain = ? AND id < ? "
                "AND content_hash IS NOT NULL ORDER BY id DESC LIMIT 1",
                (row["chain"], run_id),
            ).fetchone()
            changed = int(prev is None or prev["content_hash"] != content_hash)
        with self.conn:
            self.conn.execute(
                "UPDATE scrape_runs SET finished_at = ?, status = ?, offers_count = ?, "
                "content_hash = ?, content_changed = ?, error = ? WHERE id = ?",
                (utcnow(), status, offers_count, content_hash, changed, error, run_id),
            )

    def recent_ok_counts(self, chain: str, limit: int) -> list[int]:
        rows = self.conn.execute(
            "SELECT offers_count FROM scrape_runs WHERE chain = ? AND status = 'ok' "
            "AND offers_count IS NOT NULL ORDER BY id DESC LIMIT ?",
            (chain, limit),
        ).fetchall()
        return [r[0] for r in rows]

    def last_run(self, chain: str, status: str | None = None) -> sqlite3.Row | None:
        sql = "SELECT * FROM scrape_runs WHERE chain = ? AND status != 'running'"
        args: list[Any] = [chain]
        if status:
            sql += " AND status = ?"
            args.append(status)
        return self.conn.execute(sql + " ORDER BY id DESC LIMIT 1", args).fetchone()

    def recent_runs(self, chain: str, limit: int) -> list[sqlite3.Row]:
        """Latest finished runs of the chain, newest first."""
        return self.conn.execute(
            "SELECT * FROM scrape_runs WHERE chain = ? AND status != 'running' ORDER BY id DESC LIMIT ?",
            (chain, limit),
        ).fetchall()

    def last_success_at(self, chain: str) -> str | None:
        row = self.last_run(chain, "ok")
        return row["finished_at"] if row else None

    # ---- offers -----------------------------------------------------------

    def save_offers(self, run_id: int, chain: str, offers: Iterable[Offer]) -> dict[str, int]:
        """Upsert a run's offers in one transaction. Returns counters."""
        now = utcnow()
        stats = {"offers": 0, "new_offers": 0, "new_products": 0, "price_changes": 0}
        with self.conn:
            for o in offers:
                if o.chain != chain:
                    raise ValueError(f"offer of chain {o.chain!r} saved under {chain!r}")
                product_id, new_product = self._upsert_product(o, now)
                offer_id, new_offer = self._upsert_offer(o, product_id, run_id, now)
                self._replace_prices(offer_id, o.prices)
                stats["price_changes"] += self._observe(product_id, offer_id, run_id, now, o.prices, new_offer)
                stats["offers"] += 1
                stats["new_offers"] += int(new_offer)
                stats["new_products"] += int(new_product)
        return stats

    def _upsert_product(self, o: Offer, now: str) -> tuple[int, bool]:
        existed = self.conn.execute(
            "SELECT 1 FROM products WHERE chain = ? AND product_ref = ?", (o.chain, o.product_ref)
        ).fetchone()
        row = self.conn.execute(
            """
            INSERT INTO products (chain, product_ref, name, brand, category, unit_text,
                                  image_url, product_url, first_seen_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (chain, product_ref) DO UPDATE SET
                name = excluded.name,
                brand = COALESCE(excluded.brand, products.brand),
                category = COALESCE(excluded.category, products.category),
                unit_text = COALESCE(excluded.unit_text, products.unit_text),
                image_url = COALESCE(excluded.image_url, products.image_url),
                product_url = COALESCE(excluded.product_url, products.product_url),
                last_seen_at = excluded.last_seen_at
            RETURNING id
            """,
            (o.chain, o.product_ref, o.name, o.brand, o.category, o.unit_text,
             o.image_url, o.product_url, now, now),
        ).fetchone()
        return int(row["id"]), existed is None

    def _upsert_offer(self, o: Offer, product_id: int, run_id: int, now: str) -> tuple[int, bool]:
        row = self.conn.execute(
            """
            INSERT INTO offers (chain, source_key, product_id, name, brand, description, category,
                                unit_text, offer_label, valid_from, valid_to, image_url, product_url,
                                raw_json, first_seen_run, last_seen_run, first_seen_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (chain, source_key, valid_from, valid_to) DO UPDATE SET
                product_id = excluded.product_id,
                name = excluded.name,
                brand = excluded.brand,
                description = excluded.description,
                category = excluded.category,
                unit_text = excluded.unit_text,
                offer_label = excluded.offer_label,
                image_url = excluded.image_url,
                product_url = excluded.product_url,
                raw_json = excluded.raw_json,
                last_seen_run = excluded.last_seen_run,
                last_seen_at = excluded.last_seen_at
            RETURNING id, first_seen_run
            """,
            (o.chain, o.source_key, product_id, o.name, o.brand, o.description, o.category,
             o.unit_text, o.offer_label, _d(o.valid_from), _d(o.valid_to), o.image_url,
             o.product_url, json.dumps(o.raw, ensure_ascii=False, default=str),
             run_id, run_id, now, now),
        ).fetchone()
        return int(row["id"]), row["first_seen_run"] == run_id

    def _replace_prices(self, offer_id: int, prices: list[PriceCondition]) -> None:
        self.conn.execute("DELETE FROM offer_prices WHERE offer_id = ?", (offer_id,))
        seen: set[tuple] = set()
        for p in prices:
            if p.key in seen:  # adapters should not emit duplicates; keep the first
                continue
            seen.add(p.key)
            self.conn.execute(
                "INSERT INTO offer_prices (offer_id, kind, program, min_qty, price_cents, "
                "discount_pct, condition_text) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (offer_id, p.kind, p.program or "", p.min_qty, p.price_cents, p.discount_pct, p.condition_text),
            )

    def _observe(
        self, product_id: int, offer_id: int, run_id: int, now: str,
        prices: list[PriceCondition], new_offer: bool,
    ) -> int:
        """Append history rows for new/changed conditions; returns number of changes."""
        changes = 0
        for p in {p.key: p for p in reversed(prices)}.values():
            last = None
            if not new_offer:
                last = self.conn.execute(
                    "SELECT price_cents FROM price_observations WHERE offer_id = ? AND kind = ? "
                    "AND program = ? AND min_qty = ? ORDER BY id DESC LIMIT 1",
                    (offer_id, p.kind, p.program or "", p.min_qty),
                ).fetchone()
            if last is not None and last["price_cents"] == p.price_cents:
                continue
            if last is not None:
                changes += 1
            self.conn.execute(
                "INSERT INTO price_observations (product_id, offer_id, run_id, observed_at, kind, "
                "program, min_qty, price_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (product_id, offer_id, run_id, now, p.kind, p.program or "", p.min_qty, p.price_cents),
            )
        return changes

    # ---- reads for export -------------------------------------------------

    def offers_of_last_success(self, chain: str) -> list[dict[str, Any]]:
        """Offers seen by the chain's last successful run, with their price conditions."""
        run = self.last_run(chain, "ok")
        if run is None:
            return []
        rows = self.conn.execute(
            "SELECT o.*, p.product_ref FROM offers o JOIN products p ON p.id = o.product_id "
            "WHERE o.chain = ? AND o.last_seen_run = ? ORDER BY o.id",
            (chain, run["id"]),
        ).fetchall()
        prices: dict[int, list[dict[str, Any]]] = {}
        if rows:
            for pr in self.conn.execute(
                "SELECT op.* FROM offer_prices op JOIN offers o ON o.id = op.offer_id "
                "WHERE o.chain = ? AND o.last_seen_run = ? ORDER BY op.id",
                (chain, run["id"]),
            ):
                prices.setdefault(pr["offer_id"], []).append(
                    {
                        "kind": pr["kind"],
                        "program": pr["program"] or None,
                        "min_qty": pr["min_qty"],
                        "price_cents": pr["price_cents"],
                        "discount_pct": pr["discount_pct"],
                        "condition_text": pr["condition_text"],
                    }
                )
        out = []
        for r in rows:
            d = {k: r[k] for k in r.keys() if k not in ("raw_json", "first_seen_run", "last_seen_run")}
            d["valid_from"] = d["valid_from"] or None
            d["valid_to"] = d["valid_to"] or None
            d["prices"] = prices.get(r["id"], [])
            out.append(d)
        return out

    def price_history(self, product_id: int) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT * FROM price_observations WHERE product_id = ? ORDER BY observed_at, id",
            (product_id,),
        ).fetchall()
