from __future__ import annotations

import asyncio
import dataclasses
import logging
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from aiogram.filters import CommandObject
from fastapi.testclient import TestClient

from analytics_helpers import uid
from bg_promos.analytics.attribution import UNKNOWN
from bg_promos.analytics.store import AnalyticsStore
from bg_promos.bot import handlers, texts
from bg_promos.web.app import create_app
from test_analytics_api import START, make


def run(coro):
    return asyncio.run(coro)


def message(user) -> MagicMock:
    msg = MagicMock()
    msg.chat.type = "private"
    msg.answer = AsyncMock()
    msg.from_user = user
    return msg


def tg_user(**over):
    base = dict(id=4242, username="ann_lee", first_name="Ann", last_name=None, language_code="ru", is_bot=False)
    return SimpleNamespace(**{**base, **over})


@pytest.fixture
def store(tmp_path, monkeypatch) -> AnalyticsStore:
    st = AnalyticsStore(tmp_path / "analytics.sqlite3")
    monkeypatch.setattr(handlers, "_analytics_store", lambda: st)
    monkeypatch.setattr(handlers, "_webapp_url", lambda: "https://promos.centerai.eu")
    return st


def events(store):
    con = sqlite3.connect(store.path)
    try:
        return con.execute("SELECT e.name, e.platform, e.props, s.kind, s.campaign, s.placement, s.medium "
                           "FROM events e JOIN sessions ss ON ss.id = e.session_id "
                           "JOIN sources s ON s.id = ss.source_id").fetchall()
    finally:
        con.close()


def test_start_with_label_records_source(store):
    msg = message(tg_user())
    run(handlers.cmd_start(msg, CommandObject(command="start", args="s_spring-bot")))
    msg.answer.assert_awaited_once()
    assert msg.answer.await_args.args[0] == texts.START
    (row,) = events(store)
    assert row[0] == "bot_start" and row[1] == "bot" and '"payload_kind":"label"' in row[2]
    assert row[3:] == ("start", "spring", "bot", "bot")
    today = datetime.now(timezone.utc).date()  # cmd_start records with the real clock
    card = store.user_card(store.users(today - timedelta(days=3650), today + timedelta(days=1),
                                       include_test=True)["items"][0]["visitor_id"])
    assert card["tg_id"] == 4242 and card["username"] == "ann_lee"


def test_start_payload_kinds(store):
    run(handlers.cmd_start(message(tg_user(id=1)), CommandObject(command="start", args=None)))
    run(handlers.cmd_start(message(tg_user(id=2)), CommandObject(command="start", args="whatever")))
    run(handlers.cmd_start(message(tg_user(id=3))))  # no command object at all
    rows = events(store)
    kinds = sorted((r[2], r[3]) for r in rows)
    assert kinds == sorted([('{"payload_kind":"none"}', "unknown")] * 2 + [('{"payload_kind":"other"}', "unknown")])


def test_bot_start_without_payload_inherits_source(store):
    from bg_promos.analytics.telegram import TelegramUser
    from bg_promos.bot.analytics import record_bot_start

    user = TelegramUser(4242, "ann_lee", "Ann", None, "ru", False)
    record_bot_start(store, user, "s_spring-fb", now=START)
    vid = record_bot_start(store, user, None, now=START + timedelta(days=3))
    con = sqlite3.connect(store.path)
    try:
        rows = con.execute("SELECT src.kind, src.campaign, s.source_inherited FROM sessions s "
                           "JOIN sources src ON src.id = s.source_id ORDER BY s.started_at").fetchall()
        payload = con.execute("SELECT props FROM events WHERE name='bot_start' ORDER BY ts DESC LIMIT 1").fetchone()[0]
    finally:
        con.close()
    assert rows == [("start", "spring", 0), ("start", "spring", 1)]
    assert '"payload_kind":"none"' in payload
    assert store.user_card(vid)["sessions"][0]["source_inherited"] is True


def test_start_twice_is_two_sessions_one_visitor(store):
    for _ in range(2):
        run(handlers.cmd_start(message(tg_user()), CommandObject(command="start", args="s_a")))
    assert len(events(store)) == 2
    con = sqlite3.connect(store.path)
    assert con.execute("SELECT COUNT(*) FROM visitors").fetchone()[0] == 1
    assert con.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 2
    con.close()


def test_reply_sent_when_analytics_fails(monkeypatch, caplog):
    caplog.set_level(logging.WARNING)

    def broken():
        raise sqlite3.OperationalError("unable to open database file /secret/path")

    monkeypatch.setattr(handlers, "_analytics_store", broken)
    monkeypatch.setattr(handlers, "_webapp_url", lambda: "https://promos.centerai.eu")
    msg = message(tg_user())
    run(handlers.cmd_start(msg, CommandObject(command="start", args="s_x")))
    msg.answer.assert_awaited_once()
    assert "OperationalError" in caplog.text and "/secret/path" not in caplog.text


def test_no_record_for_missing_or_bot_user(store):
    run(handlers.cmd_start(message(None), CommandObject(command="start", args=None)))
    run(handlers.cmd_start(message(tg_user(is_bot=True)), CommandObject(command="start", args=None)))
    run(handlers.cmd_start(message(MagicMock()), CommandObject(command="start", args=None)))
    assert events(store) == []


def test_lifespan_runs_retention_at_startup(settings):
    client, app, clock = make(settings)
    svc = app.state.analytics
    s = svc.store
    src = s.get_or_create_source(UNKNOWN)
    v = s.upsert_anon_visitor("k", src, START)
    sid = uid()
    s.start_session(sid, v, "web", src, "bg", False, False, START)
    s.add_events(sid, v, "web", [{"event_id": uid(), "name": "site_open", "ts": "2024-01-01T00:00:00Z", "props": {}}])
    with TestClient(app):
        for _ in range(50):
            con = sqlite3.connect(settings.analytics_db_path)
            n = con.execute("SELECT COUNT(*) FROM events").fetchone()[0]
            con.close()
            if n == 0:
                break
            time.sleep(0.1)
    assert n == 0
