"""Admin-editable collection control: per-chain schedule overrides and "collect now" requests.

Lives in its own SQLite file (data/control.sqlite3). The API (/admin) writes it, the hourly
``collect --scheduled`` run reads it. config.ini is never modified: an override row with
``overridden = 1`` wins over config.ini, and "reset" just clears the flag (the row is kept so
``revision`` stays monotonic and an old browser tab can never hit an ABA match).
"""

from __future__ import annotations

import logging
import re
import sqlite3
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, time as dtime, timezone
from pathlib import Path
from typing import Any

from .config import Settings

log = logging.getLogger(__name__)

MAX_SLOTS = 24
_SLOT_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS schedule_override (
    chain       TEXT PRIMARY KEY,
    overridden  INTEGER NOT NULL,
    enabled     INTEGER NOT NULL,
    slots       TEXT NOT NULL,          -- "06:30,12:30"
    revision    INTEGER NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collect_requests (
    id            INTEGER PRIMARY KEY,
    chain         TEXT NOT NULL,
    requested_at  TEXT NOT NULL,
    claimed_at    TEXT,
    finished_at   TEXT,
    status        TEXT,
    run_id        INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_req_pending ON collect_requests(chain) WHERE claimed_at IS NULL;
"""


class StaleRevisionError(Exception):
    """The schedule was changed by someone else since the client read it."""

    def __init__(self, current: int) -> None:
        super().__init__(f"stale revision, current is {current}")
        self.current = current


def _iso(now: datetime | str | None = None) -> str:
    if isinstance(now, str):
        return now
    return (now or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat(timespec="seconds")


def parse_slots_list(values: Sequence[str]) -> tuple[dtime, ...]:
    """Validate "HH:MM" strings; dedupe + sort. Raises ValueError (at most 24 slots)."""
    if len(values) > MAX_SLOTS:
        raise ValueError(f"at most {MAX_SLOTS} slots")
    out: set[dtime] = set()
    for v in values:
        if not isinstance(v, str) or not _SLOT_RE.match(v):
            raise ValueError(f"invalid slot {v!r}, expected HH:MM")
        out.add(dtime(int(v[:2]), int(v[3:])))
    return tuple(sorted(out))


def format_slots(slots: Sequence[dtime]) -> list[str]:
    return [f"{s.hour:02d}:{s.minute:02d}" for s in slots]


def validate_schedule(enabled: bool, slots: Sequence[str]) -> tuple[dtime, ...]:
    """Parsed slots; enabled with no slots is invalid."""
    parsed = parse_slots_list(slots)
    if enabled and not parsed:
        raise ValueError("an enabled schedule needs at least one slot")
    return parsed


class ControlStore:
    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        # autocommit: transactions are explicit (BEGIN IMMEDIATE) where atomicity matters
        self.conn = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        try:
            self.conn.row_factory = sqlite3.Row
            self.conn.execute("PRAGMA busy_timeout = 5000")
            self.conn.execute("PRAGMA journal_mode = WAL")
            self.conn.executescript(SCHEMA)
        except Exception:
            self.conn.close()
            raise

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> ControlStore:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ---- schedule -----------------------------------------------------------------------
    def get_schedule(self, chain: str) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM schedule_override WHERE chain = ?", (chain,)).fetchone()

    def all_schedules(self) -> list[sqlite3.Row]:
        return self.conn.execute("SELECT * FROM schedule_override ORDER BY chain").fetchall()

    def _write_schedule(
        self, chain: str, expected_revision: int, overridden: bool, enabled: bool, slots: Sequence[dtime]
    ) -> int:
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            row = self.conn.execute("SELECT revision FROM schedule_override WHERE chain = ?", (chain,)).fetchone()
            current = row["revision"] if row else 0
            if current != expected_revision:
                raise StaleRevisionError(current)
            new = current + 1
            self.conn.execute(
                "INSERT INTO schedule_override (chain, overridden, enabled, slots, revision, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(chain) DO UPDATE SET overridden = excluded.overridden, "
                "enabled = excluded.enabled, slots = excluded.slots, revision = excluded.revision, "
                "updated_at = excluded.updated_at",
                (chain, int(overridden), int(enabled), ",".join(format_slots(slots)), new, _iso()),
            )
            self.conn.execute("COMMIT")
            return new
        except BaseException:
            if self.conn.in_transaction:
                self.conn.execute("ROLLBACK")
            raise

    def save_schedule(self, chain: str, enabled: bool, slots: Sequence[dtime], expected_revision: int) -> int:
        """Override config.ini for the chain; returns the new revision."""
        if enabled and not slots:
            raise ValueError("an enabled schedule needs at least one slot")
        return self._write_schedule(chain, expected_revision, True, enabled, slots)

    def reset_schedule(self, chain: str, expected_revision: int) -> int:
        """Back to config.ini; the row is kept so the revision keeps growing."""
        return self._write_schedule(chain, expected_revision, False, True, ())

    # ---- "collect now" requests ---------------------------------------------------------
    def request_run(self, chain: str, now: datetime | str | None = None) -> tuple[sqlite3.Row, bool]:
        """Queue a one-off run. One pending request per chain: a second call returns the existing one."""
        try:
            cur = self.conn.execute(
                "INSERT INTO collect_requests (chain, requested_at) VALUES (?, ?)", (chain, _iso(now))
            )
            row = self.conn.execute("SELECT * FROM collect_requests WHERE id = ?", (cur.lastrowid,)).fetchone()
            return row, True
        except sqlite3.IntegrityError:
            row = self.pending_request(chain)
            if row is None:  # claimed between our INSERT and SELECT: queue a fresh one
                return self.request_run(chain, now)
            return row, False

    def pending_request(self, chain: str) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM collect_requests WHERE chain = ? AND claimed_at IS NULL", (chain,)
        ).fetchone()

    def last_request(self, chain: str) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM collect_requests WHERE chain = ? ORDER BY id DESC LIMIT 1", (chain,)
        ).fetchone()

    def claim_request(self, req_id: int, now: datetime | str | None = None) -> bool:
        """Atomic claim: True for exactly one caller."""
        cur = self.conn.execute(
            "UPDATE collect_requests SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL", (_iso(now), req_id)
        )
        return cur.rowcount == 1

    def finish_request(
        self, req_id: int, status: str, run_id: int | None, now: datetime | str | None = None
    ) -> None:
        self.conn.execute(
            "UPDATE collect_requests SET finished_at = ?, status = ?, run_id = ? WHERE id = ?",
            (_iso(now), status, run_id, req_id),
        )

    def close_orphaned_claims(self, now: datetime | str | None = None) -> int:
        """Close requests claimed by a run that crashed before finish_request (status 'interrupted').

        Call only while holding the exclusive collection lock: then no other run can own a claim.
        Returns the number of closed rows. Requests are not re-run automatically.
        """
        cur = self.conn.execute(
            "UPDATE collect_requests SET finished_at = ?, status = 'interrupted' "
            "WHERE claimed_at IS NOT NULL AND finished_at IS NULL",
            (_iso(now),),
        )
        return cur.rowcount


@dataclass(frozen=True)
class ChainSchedule:
    enabled: bool
    slots: tuple[dtime, ...]
    source: str  # "config" | "admin"
    revision: int
    updated_at: str | None


def effective_schedule(settings: Settings, control: ControlStore | None, chain: str) -> ChainSchedule:
    """Admin override (overridden = 1) wins; otherwise config.ini slots."""
    row = control.get_schedule(chain) if control is not None else None
    if row is not None and row["overridden"]:
        slots = parse_slots_list([p for p in row["slots"].split(",") if p])
        enabled = bool(row["enabled"])
        if enabled and not slots:
            raise ValueError(f"{chain}: enabled override without slots")
        return ChainSchedule(enabled, slots, "admin", row["revision"], row["updated_at"])
    return ChainSchedule(
        True, tuple(settings.slots), "config",
        row["revision"] if row else 0, row["updated_at"] if row else None,
    )
