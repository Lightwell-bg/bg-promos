"""Codex review hardening: admin search privacy, delete/ingest race, filters, login throttle,
bot dedupe, non-ASCII credentials."""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import threading
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

from analytics_helpers import BOT_TOKEN, make_init_data, uid
from bg_promos.analytics.store import SCHEMA_VERSION, AnalyticsStore, SessionGone
from bg_promos.analytics.telegram import InitDataError, verify_init_data
from bg_promos.bot import handlers
from bg_promos.web.analytics_api import _StripAdminQuery
from test_analytics_api import PASSWORD, START, event, login, make, rows, send, web_session
from test_analytics_bot import tg_user

DAY = {"from": "2026-10-18", "to": "2026-10-18"}


@pytest.fixture
def api(settings):
    client, app, clock = make(settings)
    client.clock = clock
    client.svc = app.state.analytics
    client.cfg = settings
    return client


# ---- 1. admin search via POST, no personal text in URLs / logs ----------------------------------

def _tg(api, name="Zoya", tg_id=777):
    r = api.post("/api/v1/analytics/session", json={
        "session_id": uid(), "platform": "miniapp", "lang": "ru",
        "init_data": make_init_data(auth_date=int(START.timestamp()) - 60,
                                    user={"id": tg_id, "first_name": name, "language_code": "ru"})})
    assert r.status_code == 200, r.text
    return r.json()


def test_users_search_post_and_get_ignores_q(api):
    _tg(api, "Zoya", 777)
    _tg(api, "Boris", 778)
    login(api)
    body = {**DAY, "q": "zoya", "limit": 10, "offset": 0}
    found = api.post("/api/admin/users/search", json=body).json()
    assert found["total"] == 1 and found["items"][0]["first_name"] == "Zoya"
    # filters in the body behave like the GET filters
    assert api.post("/api/admin/users/search", json={**DAY, "platform": "web"}).json()["total"] == 0
    assert api.post("/api/admin/users/search", json={**DAY}).json()["total"] == 2
    # GET no longer searches by q
    assert api.get("/api/admin/users", params={**DAY, "q": "zoya"}).json()["total"] == 2
    api.cookies.clear()
    assert api.post("/api/admin/users/search", json=body).status_code == 401


def test_access_log_filter_drops_admin_query():
    flt = _StripAdminQuery()
    rec = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/%s" %d',
                            ("1.2.3.4:5", "GET", "/api/admin/users?from=2026-10-18&platform=web", "1.1", 200), None)
    assert flt.filter(rec)
    assert "?" not in rec.getMessage() and "/api/admin/users" in rec.getMessage()
    pub = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/%s" %d',
                            ("1.2.3.4:5", "GET", "/api/v1/offers?q=milk", "1.1", 200), None)
    flt.filter(pub)
    assert "q=milk" in pub.getMessage()


# ---- 2. FKs + delete vs ingestion race ------------------------------------------------------------

def test_foreign_keys_cascade_and_pragma(api):
    sess = web_session(api)
    send(api, sess, [event()])
    store = api.svc.store
    with store._ro() as conn:
        assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    vid = sess["visitor_id"]
    with store._tx() as conn:  # raw visitor delete cascades to sessions and events
        conn.execute("DELETE FROM visitors WHERE id=?", (vid,))
    assert rows(api, "SELECT COUNT(*) FROM sessions")[0][0] == 0
    assert rows(api, "SELECT COUNT(*) FROM events")[0][0] == 0
    with pytest.raises(sqlite3.IntegrityError):
        with store._tx() as conn:
            conn.execute("INSERT INTO sessions(id, visitor_id, platform, started_at, last_at, source_id) "
                         "VALUES ('x', 'v_missing', 'web', 't', 't', 1)")


def test_migration_v1_to_v2_keeps_data(tmp_path):
    path = tmp_path / "old.sqlite3"
    st = AnalyticsStore(path)  # creates v2
    # build a v1 database by hand: same data, no FKs, plus an orphan event
    con = sqlite3.connect(path)
    con.executescript("""
        DROP TABLE events; DROP TABLE sessions;
        CREATE TABLE sessions (id TEXT PRIMARY KEY, visitor_id TEXT NOT NULL, platform TEXT NOT NULL,
            started_at TEXT NOT NULL, last_at TEXT NOT NULL, source_id INTEGER NOT NULL, lang TEXT,
            is_automated INTEGER NOT NULL DEFAULT 0, is_test INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE events (id INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, visitor_id TEXT NOT NULL,
            session_id TEXT NOT NULL, ts TEXT NOT NULL, name TEXT NOT NULL, platform TEXT NOT NULL,
            props TEXT NOT NULL DEFAULT '{}');
        INSERT INTO sources(id, kind) VALUES (1, 'direct');
        INSERT INTO visitors(id, kind, anon_key, first_seen, last_seen, first_source_id)
            VALUES ('v_a', 'anon', 'k', 't', 't', 1);
        INSERT INTO sessions VALUES ('s1', 'v_a', 'web', 't', 't', 1, 'bg', 0, 0);
        INSERT INTO events(event_id, visitor_id, session_id, ts, name, platform) VALUES ('e1', 'v_a', 's1', 't', 'x', 'web');
        INSERT INTO events(event_id, visitor_id, session_id, ts, name, platform) VALUES ('e2', 'v_gone', 's9', 't', 'x', 'web');
        PRAGMA user_version = 1;
    """)
    con.close()
    st2 = AnalyticsStore(path)
    with st2._ro() as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION == 3
        assert conn.execute("SELECT source_inherited FROM sessions").fetchone()[0] == 0
        assert [r[0] for r in conn.execute("SELECT event_id FROM events")] == ["e1"]
        assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 1
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        assert conn.execute("PRAGMA index_list(events)").fetchall()
    assert st2.delete_visitor("v_a")
    assert st is not None


def test_race_delete_between_validation_and_insert(api):
    sess = web_session(api)
    store = api.svc.store
    real_get = store.get_session

    def get_then_delete(session_id):  # the admin deletes the user right after validation
        out = real_get(session_id)
        store.delete_visitor(out["visitor_id"])
        return out

    store.get_session = get_then_delete
    r = send(api, sess, [event()])
    store.get_session = real_get
    assert r.status_code == 401
    assert rows(api, "SELECT COUNT(*) FROM events")[0][0] == 0
    assert rows(api, "SELECT COUNT(*) FROM sessions")[0][0] == 0


def test_add_events_requires_matching_session_visitor(api):
    a, b = web_session(api), web_session(api)
    with pytest.raises(SessionGone):
        api.svc.store.add_events(a["session_id"], b["visitor_id"], "web",
                                 [{"event_id": uid(), "name": "catalog_loaded", "ts": "t", "props": {}}])
    with pytest.raises(SessionGone):
        api.svc.store.add_events(uid(), a["visitor_id"], "web",
                                 [{"event_id": uid(), "name": "catalog_loaded", "ts": "t", "props": {}}])


# ---- 3. users list cart_adds follows the filters --------------------------------------------------

def test_users_cart_adds_respect_filters(api):
    offer = {"offer_id": "a1b2c3d4e5f1", "chain": "lidl", "category": "dairy"}
    anon = uid()
    normal = web_session(api, anon_id=anon, lang="bg")
    test = web_session(api, anon_id=anon, lang="bg", test=True)
    mini_init = make_init_data(auth_date=int(START.timestamp()) - 60)
    r = api.post("/api/v1/analytics/session", json={"session_id": uid(), "platform": "miniapp", "lang": "bg",
                                                    "init_data": mini_init})
    assert r.status_code == 200
    assert normal["visitor_id"] == test["visitor_id"]
    assert send(api, normal, [event("cart_add", offer)]).status_code == 200
    assert send(api, test, [event("cart_add", offer), event("cart_add", offer)]).status_code == 200
    login(api)

    def adds(**params):
        items = api.get("/api/admin/users", params={**DAY, **params}).json()["items"]
        return {i["visitor_id"]: i["cart_adds"] for i in items}

    vid = normal["visitor_id"]
    assert adds()[vid] == 1                       # test session's adds excluded by default
    assert adds(include_test=True)[vid] == 3
    assert adds(platform="web")[vid] == 1
    assert adds(platform="miniapp").get(vid) is None
    assert adds(include_test=True, platform="web")[vid] == 3
    assert adds(lang="ru") == {}


# ---- 4. login throttle ----------------------------------------------------------------------------

def test_login_throttle_atomic_under_threads(api, settings):
    verifications = []
    lock = threading.Lock()
    real = api.svc.password_ok

    def slow_check(pw):
        with lock:
            verifications.append(pw)
        time.sleep(0.02)
        return real(pw)

    api.svc.password_ok = slow_check
    app = api.app
    codes: list[int] = []

    def attempt():
        c = TestClient(app, headers={"user-agent": "x"})
        codes.append(c.post("/api/admin/login", json={"password": "nope"}).status_code)

    threads = [threading.Thread(target=attempt) for _ in range(20)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(verifications) <= 5
    assert codes.count(429) >= 15


def test_login_success_clears_failed_attempts(api):
    for _ in range(3):
        assert api.post("/api/admin/login", json={"password": "nope"}).status_code == 401
    assert api.post("/api/admin/login", json={"password": PASSWORD}).status_code == 200
    for _ in range(5):  # a fresh budget of 5 after the success
        assert api.post("/api/admin/login", json={"password": "nope"}).status_code == 401
    assert api.post("/api/admin/login", json={"password": "nope"}).status_code == 429


# ---- 5. bot /start dedupe -------------------------------------------------------------------------

def _start_msg(chat_id=11, message_id=5):
    msg = MagicMock()
    msg.chat.type = "private"
    msg.chat.id = chat_id
    msg.message_id = message_id
    msg.answer = AsyncMock()
    msg.from_user = tg_user()
    return msg


def test_bot_start_redelivery_is_idempotent(tmp_path, monkeypatch):
    st = AnalyticsStore(tmp_path / "a.sqlite3")
    monkeypatch.setattr(handlers, "_analytics_store", lambda: st)
    monkeypatch.setattr(handlers, "_webapp_url", lambda: "https://promos.centerai.eu")
    upd = SimpleNamespace(update_id=900)
    for _ in range(2):
        asyncio.run(handlers.cmd_start(_start_msg(), None, upd))
    asyncio.run(handlers.cmd_start(_start_msg(), None, SimpleNamespace(update_id=901)))
    # no update object: falls back to chat + message id
    asyncio.run(handlers.cmd_start(_start_msg(11, 6), None, None))
    asyncio.run(handlers.cmd_start(_start_msg(11, 6), None, None))
    con = sqlite3.connect(st.path)
    try:
        assert con.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 3
        assert con.execute("SELECT COUNT(*) FROM events WHERE name='bot_start'").fetchone()[0] == 3
    finally:
        con.close()


# ---- 6. non-ASCII / malformed credentials never 500 -----------------------------------------------

def test_events_token_non_ascii_is_401(api):
    sess = web_session(api)
    for tok in ["é" * 64, "é", " ", "zz" * 32, sess["token"].upper(), sess["token"][:-1] + "é"]:
        r = send(api, sess, [event()], token=tok)
        assert r.status_code == 401, tok
    assert send(api, sess, [event()]).status_code == 200


def test_admin_cookie_non_ascii_is_401(api):
    for cookie in ["123.é", "²." + "a" * 64, "٣.abc", "9999999999." + "é" * 64, "9999999999." + "a" * 64]:
        assert api.svc.check_admin_cookie(cookie) is False, cookie  # no TypeError/ValueError
    assert api.svc.password_ok("pä\ud800ss") is False  # lone surrogate from JSON "\ud800": no 500
    assert api.post("/api/admin/login", json={"password": "pä"}).status_code == 401


def test_init_data_non_ascii_hash_raises_init_data_error():
    good = make_init_data(auth_date=1_800_000_000)
    for bad in ["é" * 64, "ß" * 64, "g" * 64]:
        with pytest.raises(InitDataError):
            verify_init_data(make_init_data(hash_override=bad), BOT_TOKEN, now=1_800_000_010)
    assert verify_init_data(good, BOT_TOKEN, now=1_800_000_010).user.id == 4242
