"""Read-only database access for the API. The API never writes."""

from __future__ import annotations

import logging
import sqlite3
from contextlib import contextmanager
from collections.abc import Iterator
from pathlib import Path

from ..storage import Storage

log = logging.getLogger(__name__)


def open_ro(path: str | Path) -> sqlite3.Connection:
    """Raw read-only connection (``mode=ro``): fails if the file does not exist."""
    uri = f"{Path(path).resolve().as_uri()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


@contextmanager
def read_storage(path: str | Path) -> Iterator[Storage]:
    """Short-lived read-only Storage: open -> read -> close."""
    storage = Storage.read_only(path)
    try:
        yield storage
    finally:
        storage.close()


def db_available(path: str | Path) -> bool:
    """True when the database can be opened and queried."""
    try:
        conn = open_ro(path)
        try:
            conn.execute("SELECT 1 FROM scrape_runs LIMIT 1").fetchall()
        finally:
            conn.close()
        return True
    except sqlite3.Error as exc:
        log.warning("database unavailable: %s", exc)
        return False
