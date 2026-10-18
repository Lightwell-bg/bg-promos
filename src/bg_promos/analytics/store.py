"""SQLite store for internal analytics (data/analytics.sqlite3, written by api and bot).

A separate file from the catalog database. Every operation opens a short-lived connection
(WAL, busy_timeout 5000), so the store is safe for FastAPI worker threads and for the bot.
All timestamps are UTC strings 'YYYY-MM-DDTHH:MM:SSZ'; period boundaries are Sofia calendar
days converted to UTC instants (DST-safe). All queries are parameterised.

Deviation from the contract sketch: ``sources`` columns are NOT NULL DEFAULT '' (SQLite treats
NULLs as distinct in UNIQUE, which would break de-duplication of sources).
"""

from __future__ import annotations

import json
import logging
import secrets
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from .attribution import Source
from .events import utc_iso
from .telegram import TelegramUser

log = logging.getLogger(__name__)

SCHEMA_VERSION = 2
PLATFORMS = ("web", "miniapp", "bot")

_SCHEMA_V1 = """
CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    medium TEXT NOT NULL DEFAULT '',
    campaign TEXT NOT NULL DEFAULT '',
    placement TEXT NOT NULL DEFAULT '',
    UNIQUE(kind, source, medium, campaign, placement)
);
CREATE TABLE visitors (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('tg', 'anon')),
    tg_id INTEGER UNIQUE,
    username TEXT, first_name TEXT, last_name TEXT, language TEXT,
    anon_key TEXT UNIQUE,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    first_source_id INTEGER REFERENCES sources(id),
    is_test INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    visitor_id TEXT NOT NULL REFERENCES visitors(id),
    platform TEXT NOT NULL,
    started_at TEXT NOT NULL,
    last_at TEXT NOT NULL,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    lang TEXT,
    is_automated INTEGER NOT NULL DEFAULT 0,
    is_test INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    visitor_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    props TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_name_ts ON events(name, ts);
CREATE INDEX idx_events_visitor_ts ON events(visitor_id, ts);
CREATE INDEX idx_events_session ON events(session_id);
CREATE INDEX idx_sessions_started ON sessions(started_at);
CREATE INDEX idx_sessions_visitor ON sessions(visitor_id);
"""

_INDEXES = """
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_name_ts ON events(name, ts);
CREATE INDEX idx_events_visitor_ts ON events(visitor_id, ts);
CREATE INDEX idx_events_session ON events(session_id);
CREATE INDEX idx_sessions_started ON sessions(started_at);
CREATE INDEX idx_sessions_visitor ON sessions(visitor_id)
"""

# v2: foreign keys with ON DELETE CASCADE. SQLite cannot add FKs in place, so sessions/events
# are recreated and the data copied (orphans that could never satisfy the FKs are dropped).
_SCHEMA_V2 = """
CREATE TABLE sessions_new (
    id TEXT PRIMARY KEY,
    visitor_id TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    started_at TEXT NOT NULL,
    last_at TEXT NOT NULL,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    lang TEXT,
    is_automated INTEGER NOT NULL DEFAULT 0,
    is_test INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE events_new (
    id INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    visitor_id TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    props TEXT NOT NULL DEFAULT '{}'
);
INSERT INTO sessions_new SELECT * FROM sessions WHERE visitor_id IN (SELECT id FROM visitors)
    AND source_id IN (SELECT id FROM sources);
INSERT INTO events_new SELECT * FROM events WHERE visitor_id IN (SELECT id FROM visitors)
    AND session_id IN (SELECT id FROM sessions_new);
DROP TABLE events;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
ALTER TABLE events_new RENAME TO events;
""" + _INDEXES

_MIGRATIONS = {1: _SCHEMA_V1, 2: _SCHEMA_V2}


class SessionGone(Exception):
    """The session (or its visitor) no longer exists: it was deleted or never belonged to the visitor."""


def new_visitor_id() -> str:
    return "v_" + secrets.token_hex(10)


def _src_row(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    return {k: (row[k] or None) for k in ("kind", "source", "medium", "campaign", "placement")}


class AnalyticsStore:
    def __init__(self, path: str | Path, tz: str = "Europe/Sofia") -> None:
        self.path = Path(path)
        self.tz = ZoneInfo(tz)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._migrate()

    # ---- connections ----------------------------------------------------------------------
    def _connect(self, foreign_keys: bool = True) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute(f"PRAGMA foreign_keys = {'ON' if foreign_keys else 'OFF'}")
        return conn

    @contextmanager
    def _tx(self, foreign_keys: bool = True) -> Iterator[sqlite3.Connection]:
        conn = self._connect(foreign_keys)
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            conn.execute("COMMIT")
        finally:
            conn.close()

    @contextmanager
    def _ro(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            yield conn
        finally:
            conn.close()

    def _migrate(self) -> None:
        # FK enforcement is off while tables are recreated (the pragma is a no-op inside a transaction)
        with self._tx(foreign_keys=False) as conn:
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            for target in range(version + 1, SCHEMA_VERSION + 1):
                for stmt in _MIGRATIONS[target].split(";"):
                    if stmt.strip():
                        conn.execute(stmt)
                conn.execute(f"PRAGMA user_version = {target}")

    # ---- writes ---------------------------------------------------------------------------
    @staticmethod
    def _source_id(conn: sqlite3.Connection, s: Source) -> int:
        vals = (s.kind, s.source or "", s.medium or "", s.campaign or "", s.placement or "")
        conn.execute(
            "INSERT OR IGNORE INTO sources(kind, source, medium, campaign, placement) VALUES (?,?,?,?,?)", vals
        )
        return conn.execute(
            "SELECT id FROM sources WHERE kind=? AND source=? AND medium=? AND campaign=? AND placement=?", vals
        ).fetchone()[0]

    def get_or_create_source(self, source: Source) -> int:
        with self._tx() as conn:
            return self._source_id(conn, source)

    def upsert_tg_visitor(self, user: TelegramUser, source_id: int, now: datetime) -> str:
        ts = utc_iso(now)
        with self._tx() as conn:
            row = conn.execute("SELECT id FROM visitors WHERE tg_id=?", (user.id,)).fetchone()
            if row:
                conn.execute(
                    "UPDATE visitors SET username=?, first_name=?, last_name=?, language=?, "
                    "last_seen=MAX(last_seen, ?) WHERE id=?",
                    (user.username, user.first_name, user.last_name, user.language_code, ts, row["id"]),
                )
                return row["id"]
            vid = new_visitor_id()
            conn.execute(
                "INSERT INTO visitors(id, kind, tg_id, username, first_name, last_name, language, "
                "first_seen, last_seen, first_source_id) VALUES (?, 'tg', ?, ?, ?, ?, ?, ?, ?, ?)",
                (vid, user.id, user.username, user.first_name, user.last_name, user.language_code,
                 ts, ts, source_id),
            )
            return vid

    def upsert_anon_visitor(self, anon_key: str, source_id: int, now: datetime) -> str:
        ts = utc_iso(now)
        with self._tx() as conn:
            row = conn.execute("SELECT id FROM visitors WHERE anon_key=?", (anon_key,)).fetchone()
            if row:
                conn.execute("UPDATE visitors SET last_seen=MAX(last_seen, ?) WHERE id=?", (ts, row["id"]))
                return row["id"]
            vid = new_visitor_id()
            conn.execute(
                "INSERT INTO visitors(id, kind, anon_key, first_seen, last_seen, first_source_id) "
                "VALUES (?, 'anon', ?, ?, ?, ?)",
                (vid, anon_key, ts, ts, source_id),
            )
            return vid

    def start_session(
        self, session_id: str, visitor_id: str, platform: str, source_id: int, lang: str | None,
        is_automated: bool, is_test: bool, now: datetime,
    ) -> bool:
        """Create the session; False when it already exists (idempotent on session_id)."""
        ts = utc_iso(now)
        with self._tx() as conn:
            cur = conn.execute(
                "INSERT OR IGNORE INTO sessions(id, visitor_id, platform, started_at, last_at, source_id, "
                "lang, is_automated, is_test) VALUES (?,?,?,?,?,?,?,?,?)",
                (session_id, visitor_id, platform, ts, ts, source_id, lang, int(is_automated), int(is_test)),
            )
            if cur.rowcount and is_test:
                conn.execute("UPDATE visitors SET is_test=1 WHERE id=?", (visitor_id,))
            return cur.rowcount == 1

    def get_session(self, session_id: str) -> dict | None:
        with self._ro() as conn:
            row = conn.execute(
                "SELECT id, visitor_id, platform, started_at, last_at FROM sessions WHERE id=?", (session_id,)
            ).fetchone()
        return dict(row) if row else None

    def add_events(self, session_id: str, visitor_id: str, platform: str, events: list[dict]) -> tuple[int, int]:
        """INSERT OR IGNORE by event_id. Returns (accepted, duplicates).

        The session is re-checked inside the same write transaction as the inserts, so a visitor
        deleted meanwhile (admin) cannot get orphan events: raises SessionGone, nothing inserted.
        """
        accepted = 0
        with self._tx() as conn:
            if conn.execute("SELECT 1 FROM sessions WHERE id=? AND visitor_id=?",
                            (session_id, visitor_id)).fetchone() is None:
                raise SessionGone(session_id)
            for ev in events:
                cur = conn.execute(
                    "INSERT OR IGNORE INTO events(event_id, visitor_id, session_id, ts, name, platform, props) "
                    "VALUES (?,?,?,?,?,?,?)",
                    (ev["event_id"], visitor_id, session_id, ev["ts"], ev["name"], platform,
                     json.dumps(ev.get("props") or {}, ensure_ascii=False, separators=(",", ":"))),
                )
                accepted += cur.rowcount
        return accepted, len(events) - accepted

    def touch_session(self, session_id: str, now: datetime) -> None:
        ts = utc_iso(now)
        with self._tx() as conn:
            conn.execute("UPDATE sessions SET last_at=MAX(last_at, ?) WHERE id=?", (ts, session_id))
            conn.execute(
                "UPDATE visitors SET last_seen=MAX(last_seen, ?) "
                "WHERE id=(SELECT visitor_id FROM sessions WHERE id=?)", (ts, session_id))

    def purge_events_older_than(self, cutoff: datetime) -> int:
        with self._tx() as conn:
            return conn.execute("DELETE FROM events WHERE ts < ?", (utc_iso(cutoff),)).rowcount

    def delete_visitor(self, visitor_id: str) -> bool:
        with self._tx() as conn:
            conn.execute("DELETE FROM events WHERE visitor_id=?", (visitor_id,))
            conn.execute("DELETE FROM sessions WHERE visitor_id=?", (visitor_id,))
            return conn.execute("DELETE FROM visitors WHERE id=?", (visitor_id,)).rowcount == 1

    # ---- query helpers --------------------------------------------------------------------
    def period_bounds(self, d_from: date, d_to: date) -> tuple[str, str]:
        """Sofia calendar days [d_from, d_to] -> UTC [lo, hi) strings."""
        lo = datetime.combine(d_from, time(0), tzinfo=self.tz)
        hi = datetime.combine(d_to + timedelta(days=1), time(0), tzinfo=self.tz)
        return utc_iso(lo), utc_iso(hi)

    @staticmethod
    def _filters(platform, lang, source_kind, source, campaign, include_test, include_automated) -> tuple[str, list]:
        """WHERE fragment over aliases s (sessions) and src (sources)."""
        sql, params = [], []
        if not include_test:
            sql.append("s.is_test = 0")
        if not include_automated:
            sql.append("s.is_automated = 0")
        for col, val in (("s.platform", platform), ("s.lang", lang), ("src.kind", source_kind),
                         ("src.source", source), ("src.campaign", campaign)):
            if val:
                sql.append(f"{col} = ?")
                params.append(val)
        return (" AND " + " AND ".join(sql)) if sql else "", params

    # ---- metrics --------------------------------------------------------------------------
    def metrics(
        self, d_from: date, d_to: date, *, platform: str | None = None, lang: str | None = None,
        source_kind: str | None = None, source: str | None = None, campaign: str | None = None,
        include_test: bool = False, include_automated: bool = False,
    ) -> dict:
        lo, hi = self.period_bounds(d_from, d_to)
        flt, fp = self._filters(platform, lang, source_kind, source, campaign, include_test, include_automated)
        sess_from = "FROM sessions s JOIN sources src ON src.id = s.source_id JOIN visitors v ON v.id = s.visitor_id"
        ev_from = ("FROM events e JOIN sessions s ON s.id = e.session_id "
                   "JOIN sources src ON src.id = s.source_id")
        ev_where = "WHERE e.ts >= ? AND e.ts < ?" + flt
        ev_params = [lo, hi, *fp]
        with self._ro() as conn:
            sess = conn.execute(
                f"SELECT COUNT(*) AS sessions, COUNT(DISTINCT s.visitor_id) AS users, "
                f"COUNT(DISTINCT CASE WHEN v.kind='tg' THEN s.visitor_id END) AS tg, "
                f"COUNT(DISTINCT CASE WHEN v.kind='anon' THEN s.visitor_id END) AS anon "
                f"{sess_from} WHERE s.started_at >= ? AND s.started_at < ?{flt}",
                [lo, hi, *fp],
            ).fetchone()
            counts = {r["name"]: r["n"] for r in conn.execute(
                f"SELECT e.name AS name, COUNT(*) AS n {ev_from} {ev_where} GROUP BY e.name", ev_params)}
            cart_users = conn.execute(
                f"SELECT COUNT(DISTINCT e.visitor_id) {ev_from} {ev_where} AND e.name = 'cart_add'", ev_params
            ).fetchone()[0]
            imports_ok = conn.execute(
                f"SELECT COUNT(*) {ev_from} {ev_where} AND e.name = 'cart_import' "
                f"AND json_extract(e.props, '$.mode') IN ('filled', 'created')", ev_params
            ).fetchone()[0]

            def top(name: str) -> list[dict]:
                rows = conn.execute(
                    f"SELECT json_extract(e.props,'$.offer_id') AS offer_id, "
                    f"json_extract(e.props,'$.chain') AS chain, json_extract(e.props,'$.category') AS category, "
                    f"COUNT(*) AS n {ev_from} {ev_where} AND e.name = ? GROUP BY 1, 2, 3 "
                    f"ORDER BY n DESC, offer_id LIMIT 20", [*ev_params, name])
                return [dict(offer_id=r["offer_id"], chain=r["chain"], category=r["category"], count=r["n"])
                        for r in rows]

            top_viewed, top_carted = top("offer_view"), top("cart_add")
            zero = [dict(query=r["q"], count=r["n"]) for r in conn.execute(
                f"SELECT json_extract(e.props,'$.query') AS q, COUNT(*) AS n {ev_from} {ev_where} "
                f"AND e.name = 'search' AND json_extract(e.props,'$.results') = 0 "
                f"AND json_extract(e.props,'$.query') IS NOT NULL "
                f"GROUP BY q ORDER BY n DESC, q LIMIT 50", ev_params)]
            # MAX(e.ts) makes SQLite take the bare columns (stack, path) from the latest row of a group.
            errors = [dict(name=r["nm"], where=r["wh"], message=r["msg"], source=r["src"], file=r["fl"],
                           line=r["ln"], col=r["cl"], count=r["n"], last_seen=r["last_seen"],
                           stack=r["stk"], path=r["pth"])
                      for r in conn.execute(
                f"SELECT json_extract(e.props,'$.name') AS nm, json_extract(e.props,'$.where') AS wh, "
                f"json_extract(e.props,'$.message') AS msg, json_extract(e.props,'$.source') AS src, "
                f"json_extract(e.props,'$.file') AS fl, json_extract(e.props,'$.line') AS ln, "
                f"json_extract(e.props,'$.col') AS cl, COUNT(*) AS n, MAX(e.ts) AS last_seen, "
                f"json_extract(e.props,'$.stack') AS stk, json_extract(e.props,'$.path') AS pth "
                f"{ev_from} {ev_where} AND e.name = 'app_error' "
                f"GROUP BY nm, wh, msg, src, fl, ln ORDER BY n DESC, last_seen DESC LIMIT 50", ev_params)]
            active = [r[0] for r in conn.execute(
                f"SELECT DISTINCT s.visitor_id {sess_from} WHERE s.started_at >= ? AND s.started_at < ?{flt}",
                [lo, hi, *fp])]
            returning = self._returning(conn, active, include_test, include_automated)
        return {
            "period": {"from": d_from.isoformat(), "to": d_to.isoformat()},
            "users": {"total": sess["users"], "tg": sess["tg"], "anon": sess["anon"]},
            "sessions": sess["sessions"],
            "bot_starts": counts.get("bot_start", 0),
            "miniapp_opens": counts.get("miniapp_open", 0),
            "site_opens": counts.get("site_open", 0),
            "catalog_loads": counts.get("catalog_loaded", 0),
            "cart_add_users": cart_users,
            "share_links": counts.get("share_link_created", 0),
            "imports_successful": imports_ok,
            "returning_visitors": returning,
            "top_offers": {"viewed": top_viewed, "carted": top_carted},
            "zero_result_queries": zero,
            "errors": errors,
        }

    def _returning(self, conn: sqlite3.Connection, visitor_ids: list[str],
                   include_test: bool, include_automated: bool) -> int:
        """Visitors (of ``visitor_ids``) with sessions on >= 2 distinct Sofia calendar days, ever."""
        if not visitor_ids:
            return 0
        days: dict[str, set[date]] = {}
        extra = ("" if include_test else " AND is_test = 0") + ("" if include_automated else " AND is_automated = 0")
        for i in range(0, len(visitor_ids), 500):
            chunk = visitor_ids[i:i + 500]
            marks = ",".join("?" * len(chunk))
            for r in conn.execute(
                f"SELECT visitor_id, started_at FROM sessions WHERE visitor_id IN ({marks}){extra}", chunk
            ):
                dt = datetime.strptime(r["started_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
                days.setdefault(r["visitor_id"], set()).add(dt.astimezone(self.tz).date())
        return sum(1 for d in days.values() if len(d) >= 2)

    # ---- users ----------------------------------------------------------------------------
    def users(
        self, d_from: date, d_to: date, *, platform: str | None = None, lang: str | None = None,
        source_kind: str | None = None, source: str | None = None, campaign: str | None = None,
        include_test: bool = False, include_automated: bool = False,
        q: str | None = None, limit: int = 50, offset: int = 0,
    ) -> dict:
        lo, hi = self.period_bounds(d_from, d_to)
        flt, fp = self._filters(platform, lang, source_kind, source, campaign, include_test, include_automated)
        where = f"WHERE s.started_at >= ? AND s.started_at < ?{flt}"
        params: list = [lo, hi, *fp]
        q = (q or "").strip()[:100]
        if q:
            like = "%" + q.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_").lstrip("@") + "%"
            cond = ("(LOWER(COALESCE(v.username,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(v.first_name,'')) "
                    "LIKE ? ESCAPE '\\' OR LOWER(COALESCE(v.last_name,'')) LIKE ? ESCAPE '\\' OR v.id = ?")
            params += [like, like, like, q]
            if q.isdigit():
                cond += " OR v.tg_id = ?"
                params.append(int(q))
            where += " AND " + cond + ")"
        limit = max(1, min(int(limit), 200))
        offset = max(0, int(offset))
        base = ("FROM sessions s JOIN sources src ON src.id = s.source_id "
                "JOIN visitors v ON v.id = s.visitor_id " + where)
        with self._ro() as conn:
            total = conn.execute(f"SELECT COUNT(DISTINCT v.id) {base}", params).fetchone()[0]
            rows = conn.execute(
                f"SELECT v.id, v.kind, v.tg_id, v.username, v.first_name, v.last_name, v.language, "
                f"v.first_seen, v.last_seen, v.first_source_id, COUNT(*) AS sessions "
                f"{base} GROUP BY v.id ORDER BY v.last_seen DESC, v.id LIMIT ? OFFSET ?",
                [*params, limit, offset]).fetchall()
            items = []
            for r in rows:
                fs = conn.execute("SELECT * FROM sources WHERE id=?", (r["first_source_id"],)).fetchone()
                adds = conn.execute(
                    "SELECT COUNT(*) FROM events e JOIN sessions s ON s.id = e.session_id "
                    "JOIN sources src ON src.id = s.source_id "
                    f"WHERE e.visitor_id=? AND e.name='cart_add' AND e.ts >= ? AND e.ts < ?{flt}",
                    [r["id"], lo, hi, *fp]).fetchone()[0]
                items.append({
                    "visitor_id": r["id"], "kind": r["kind"], "tg_id": r["tg_id"], "username": r["username"],
                    "first_name": r["first_name"], "last_name": r["last_name"], "language": r["language"],
                    "first_seen": r["first_seen"], "last_seen": r["last_seen"],
                    "first_source": _src_row(fs), "sessions": r["sessions"], "cart_adds": adds,
                })
        return {"total": total, "limit": limit, "offset": offset, "items": items}

    def user_card(self, visitor_id: str, *, events_limit: int = 500, sessions_limit: int = 200) -> dict | None:
        with self._ro() as conn:
            v = conn.execute("SELECT * FROM visitors WHERE id=?", (visitor_id,)).fetchone()
            if v is None:
                return None
            fs = conn.execute("SELECT * FROM sources WHERE id=?", (v["first_source_id"],)).fetchone()
            sessions = [
                {"session_id": r["id"], "platform": r["platform"], "started_at": r["started_at"],
                 "last_at": r["last_at"], "lang": r["lang"], "is_automated": bool(r["is_automated"]),
                 "is_test": bool(r["is_test"]), "source": _src_row(r),
                 "events": r["events"]}
                for r in conn.execute(
                    "SELECT s.*, src.kind, src.source, src.medium, src.campaign, src.placement, "
                    "(SELECT COUNT(*) FROM events e WHERE e.session_id = s.id) AS events "
                    "FROM sessions s JOIN sources src ON src.id = s.source_id "
                    "WHERE s.visitor_id=? ORDER BY s.started_at DESC LIMIT ?", (visitor_id, sessions_limit))
            ]
            events = [
                {"ts": r["ts"], "name": r["name"], "platform": r["platform"], "session_id": r["session_id"],
                 "props": json.loads(r["props"] or "{}")}
                for r in conn.execute(
                    "SELECT ts, name, platform, session_id, props FROM events WHERE visitor_id=? "
                    "ORDER BY ts DESC, id DESC LIMIT ?", (visitor_id, events_limit))
            ]
        anonymous = v["kind"] == "anon"
        return {
            "visitor_id": v["id"], "kind": v["kind"], "is_anonymous": anonymous,
            "tg_id": v["tg_id"], "username": v["username"], "first_name": v["first_name"],
            "last_name": v["last_name"], "language": v["language"],
            "first_seen": v["first_seen"], "last_seen": v["last_seen"],
            "first_source": _src_row(fs), "is_test": bool(v["is_test"]),
            "sessions": sessions, "events": events,
        }

    def filters(self) -> dict:
        with self._ro() as conn:
            def col(sql: str) -> list[str]:
                return [r[0] for r in conn.execute(sql) if r[0]]
            return {
                "platforms": col("SELECT DISTINCT platform FROM sessions ORDER BY 1"),
                "langs": col("SELECT DISTINCT lang FROM sessions ORDER BY 1"),
                "source_kinds": col("SELECT DISTINCT kind FROM sources ORDER BY 1"),
                "sources": col("SELECT DISTINCT source FROM sources ORDER BY 1"),
                "campaigns": col("SELECT DISTINCT campaign FROM sources ORDER BY 1"),
            }
