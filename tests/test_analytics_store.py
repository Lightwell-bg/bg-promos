from __future__ import annotations

import sqlite3
from datetime import date, datetime, timedelta, timezone

import pytest

from analytics_helpers import uid
from bg_promos.analytics.attribution import UNKNOWN, Source
from bg_promos.analytics.store import AnalyticsStore
from bg_promos.analytics.telegram import TelegramUser

D1, D3 = date(2026, 10, 10), date(2026, 10, 12)
OPEN = {"web": "site_open", "miniapp": "miniapp_open", "bot": "bot_start"}


def at(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def tg(i: int, first: str = "Ann", username: str | None = None) -> TelegramUser:
    return TelegramUser(i, username, first, None, "ru", False)


def ev(name: str, props: dict | None = None, ts: str = "2026-10-10T10:00:00Z") -> dict:
    return {"event_id": uid(), "name": name, "ts": ts, "props": props or {}}


@pytest.fixture
def store(tmp_path) -> AnalyticsStore:
    return AnalyticsStore(tmp_path / "analytics.sqlite3")


class Seed:
    def __init__(self, store: AnalyticsStore) -> None:
        self.store = store

    def source(self, **kw) -> int:
        return self.store.get_or_create_source(Source(**kw) if kw else UNKNOWN)

    def tg_visitor(self, user: TelegramUser, source_id: int, when: str) -> str:
        return self.store.upsert_tg_visitor(user, source_id, at(when))

    def anon_visitor(self, key: str, source_id: int, when: str) -> str:
        return self.store.upsert_anon_visitor(key, source_id, at(when))

    def session(self, vid, platform, when, source_id, lang="bg", events=(), automated=False, test=False,
                opened=True) -> str:
        sid = uid()
        self.store.start_session(sid, vid, platform, source_id, lang, automated, test, at(when))
        evs = ([ev(OPEN[platform], ts=when)] if opened else []) + [{**e, "ts": when} for e in events]
        self.store.add_events(sid, vid, platform, evs)
        return sid


O1 = {"offer_id": "o1", "chain": "lidl", "category": "dairy"}
O2 = {"offer_id": "o2", "chain": "billa", "category": "meat"}
O3 = {"offer_id": "o3", "chain": "kaufland", "category": "fruit"}
ERR_DETAIL = {
    "name": "RangeError", "where": "window", "message": "boom", "source": "own",
    "file": "/assets/index-abc.js", "line": 10, "col": 5,
    "stack": "RangeError: boom\n    at f (/assets/index-abc.js:10:5)", "path": "/ru/cart",
}


@pytest.fixture
def seeded(store) -> AnalyticsStore:
    s = Seed(store)
    app = s.source(kind="startapp", source="telegram", medium="miniapp", campaign="spring", placement="ig")
    bot = s.source(kind="start", source="telegram", medium="bot", campaign="spring")
    utm = s.source(kind="utm", source="instagram", medium="social", campaign="autumn")
    unk = s.source()
    # A: Telegram, two Sofia days -> returning
    a = s.tg_visitor(tg(1, "Ann", "ann_lee"), app, "2026-10-10T10:00:00Z")
    s.session(a, "miniapp", "2026-10-10T10:00:00Z", app, "ru", [
        ev("catalog_loaded", {"offers": 100, "from_cache": False}), ev("offer_view", O1),
        ev("cart_add", O1), ev("cart_add", O1), ev("share_link_created", {"lines": 2, "telegram": True}),
        ev("cart_import", {"mode": "filled", "added": 2, "missing": 0}),
        ev("cart_import", {"mode": "empty", "added": 0, "missing": 3}),
    ])
    s.session(a, "miniapp", "2026-10-11T10:00:00Z", app, "ru", [
        ev("cart_import", {"mode": "created", "added": 1, "missing": 0}), ev("offer_view", O1)])
    # B: anonymous, extra session before the period -> returning "ever"
    b = s.anon_visitor("key-b", utm, "2026-10-01T10:00:00Z")
    s.session(b, "web", "2026-10-01T10:00:00Z", utm, "bg")
    s.session(b, "web", "2026-10-10T12:00:00Z", utm, "bg", [
        ev("catalog_loaded", {"offers": 90, "from_cache": True}), ev("offer_view", O2), ev("cart_add", O2),
        ev("search", {"len": 6, "results": 0, "query": "мляко"}),
        ev("search", {"len": 6, "results": 0, "query": "мляко"}),
        ev("search", {"len": 4, "results": 5}),
        ev("app_error", {"name": "TypeError", "where": "Page"}),
        ev("app_error", ERR_DETAIL), ev("app_error", ERR_DETAIL),
        ev("app_error", {**ERR_DETAIL, "line": 99}),
    ])
    # E: bot start only
    e = s.tg_visitor(tg(2, "Eve", "eve_e"), bot, "2026-10-11T08:00:00Z")
    s.session(e, "bot", "2026-10-11T08:00:00Z", bot, "ru")  # records bot_start
    # F: 23:30 and 00:30 Sofia (same UTC day) -> two Sofia days
    f = s.anon_visitor("key-f", unk, "2026-10-10T20:30:00Z")
    s.session(f, "web", "2026-10-10T20:30:00Z", unk, "bg")
    s.session(f, "web", "2026-10-10T21:30:00Z", unk, "bg")
    # G: 00:10 and 23:50 Sofia on the SAME Sofia day (different UTC days) -> not returning
    g = s.anon_visitor("key-g", unk, "2026-10-10T21:10:00Z")
    s.session(g, "web", "2026-10-10T21:10:00Z", unk, "en")
    s.session(g, "web", "2026-10-11T20:50:00Z", unk, "en")
    # L: last second of the period; K / M: just outside on both sides
    l = s.anon_visitor("key-l", unk, "2026-10-12T20:59:59Z")
    s.session(l, "web", "2026-10-12T20:59:59Z", unk, "en")
    k = s.anon_visitor("key-k", unk, "2026-10-12T21:00:00Z")
    s.session(k, "web", "2026-10-12T21:00:00Z", unk, "en")
    m = s.anon_visitor("key-m", unk, "2026-10-09T20:59:59Z")
    s.session(m, "web", "2026-10-09T20:59:59Z", unk, "en")
    # automated and test traffic
    h = s.anon_visitor("key-h", unk, "2026-10-10T09:00:00Z")
    s.session(h, "web", "2026-10-10T09:00:00Z", unk, "bg", [ev("cart_add", O3)], automated=True)
    t = s.anon_visitor("key-t", unk, "2026-10-10T09:30:00Z")
    s.session(t, "web", "2026-10-10T09:30:00Z", unk, "bg", test=True)
    return store


def metrics(store, **kw):
    return store.metrics(D1, D3, **kw)


def test_metrics_default(seeded):
    m = metrics(seeded)
    assert m["users"] == {"total": 6, "tg": 2, "anon": 4}
    assert m["sessions"] == 9
    assert m["bot_starts"] == 1 and m["miniapp_opens"] == 2 and m["site_opens"] == 6
    assert m["catalog_loads"] == 2
    assert m["cart_add_users"] == 2  # A and B (automated H excluded)
    assert m["share_links"] == 1
    assert m["imports_successful"] == 2  # filled + created, not "empty"
    assert m["returning_visitors"] == 3  # A, B (session before the period), F; not G
    assert m["top_offers"]["viewed"][0] == {"offer_id": "o1", "chain": "lidl", "category": "dairy", "count": 2}
    assert [o["offer_id"] for o in m["top_offers"]["carted"]] == ["o1", "o2"]
    assert m["zero_result_queries"] == [{"query": "мляко", "count": 2}]
    errors = m["errors"]
    assert len(errors) == 3  # same name/where/message/file but another line is a separate group
    top = errors[0]
    assert (top["name"], top["where"], top["message"], top["source"]) == ("RangeError", "window", "boom", "own")
    assert (top["file"], top["line"], top["col"], top["count"]) == ("/assets/index-abc.js", 10, 5, 2)
    assert top["stack"] == "RangeError: boom\n    at f (/assets/index-abc.js:10:5)"
    assert top["path"] == "/ru/cart" and top["last_seen"].startswith("2026-10-10")
    old = [e for e in errors if e["name"] == "TypeError"][0]  # legacy event without details
    assert (old["where"], old["count"], old["message"], old["stack"], old["line"]) == ("Page", 1, None, None, None)
    assert m["period"] == {"from": "2026-10-10", "to": "2026-10-12"}


def test_metrics_include_flags(seeded):
    both = metrics(seeded, include_test=True, include_automated=True)
    assert both["users"]["total"] == 8 and both["sessions"] == 11 and both["site_opens"] == 8
    assert both["cart_add_users"] == 3
    assert metrics(seeded, include_test=True)["users"]["total"] == 7
    assert metrics(seeded, include_automated=True)["cart_add_users"] == 3


def test_metrics_filters(seeded):
    miniapp = metrics(seeded, platform="miniapp")
    assert miniapp["users"]["total"] == 1 and miniapp["sessions"] == 2 and miniapp["site_opens"] == 0
    bg = metrics(seeded, lang="bg")
    assert bg["sessions"] == 3 and bg["users"]["total"] == 2
    spring = metrics(seeded, campaign="spring")
    assert spring["users"]["total"] == 2 and spring["bot_starts"] == 1 and spring["miniapp_opens"] == 2
    assert metrics(seeded, source_kind="start")["users"]["total"] == 1
    insta = metrics(seeded, source="instagram")
    assert insta["users"]["total"] == 1 and insta["cart_add_users"] == 1 and insta["sessions"] == 1
    assert metrics(seeded, campaign="nope")["users"]["total"] == 0
    # SQL metacharacters in filters are parameters, not SQL
    assert metrics(seeded, source="x' OR '1'='1")["users"]["total"] == 0


def test_period_bounds_dst(store):
    assert store.period_bounds(date(2026, 10, 24), date(2026, 10, 24)) == (
        "2026-10-23T21:00:00Z", "2026-10-24T21:00:00Z")
    # 2026-10-25: DST ends in Sofia, the day lasts 25 hours
    assert store.period_bounds(date(2026, 10, 25), date(2026, 10, 25)) == (
        "2026-10-24T21:00:00Z", "2026-10-25T22:00:00Z")
    # 2026-03-29: DST starts, the day lasts 23 hours
    assert store.period_bounds(date(2026, 3, 29), date(2026, 3, 29)) == (
        "2026-03-28T22:00:00Z", "2026-03-29T21:00:00Z")


def test_returning_across_dst_day_boundary(store):
    s = Seed(store)
    unk = s.source()
    v = s.anon_visitor("dst", unk, "2026-10-24T20:30:00Z")
    # 23:30 Sofia (UTC+3) on Oct 24 and 23:30 Sofia (UTC+2) on Oct 25 = 21:30Z
    s.session(v, "web", "2026-10-24T20:30:00Z", unk)
    s.session(v, "web", "2026-10-25T21:30:00Z", unk)
    w = s.anon_visitor("dst2", unk, "2026-10-25T00:10:00Z")
    # 03:10 and 23:10 Sofia on Oct 25 (a 25-hour day): one day only
    s.session(w, "web", "2026-10-25T00:10:00Z", unk)
    s.session(w, "web", "2026-10-25T21:10:00Z", unk)
    m = store.metrics(date(2026, 10, 24), date(2026, 10, 25))
    assert m["users"]["total"] == 2 and m["returning_visitors"] == 1


def test_users_list_and_card(seeded):
    res = seeded.users(D1, D3)
    assert res["total"] == 6 and len(res["items"]) == 6
    by_tg = {i["tg_id"]: i for i in res["items"] if i["tg_id"]}
    assert by_tg[1]["username"] == "ann_lee" and by_tg[1]["sessions"] == 2 and by_tg[1]["cart_adds"] == 2
    assert by_tg[1]["first_source"]["campaign"] == "spring" and by_tg[1]["first_source"]["placement"] == "ig"
    assert [i["tg_id"] for i in seeded.users(D1, D3, q="1")["items"]] == [1]
    assert [i["tg_id"] for i in seeded.users(D1, D3, q="@EVE")["items"]] == [2]
    assert seeded.users(D1, D3, q="%")["total"] == 0  # LIKE wildcards are escaped
    assert len(seeded.users(D1, D3, limit=2)["items"]) == 2
    card = seeded.user_card(by_tg[1]["visitor_id"])
    assert card["is_anonymous"] is False and card["tg_id"] == 1 and len(card["sessions"]) == 2
    assert card["events"][0]["ts"] >= card["events"][-1]["ts"]
    anon_id = next(i["visitor_id"] for i in res["items"] if i["kind"] == "anon")
    anon = seeded.user_card(anon_id)
    assert anon["is_anonymous"] is True and anon["tg_id"] is None and "anon_key" not in anon
    assert seeded.user_card("v_missing") is None


def test_filters_listing(seeded):
    f = seeded.filters()
    assert set(f["platforms"]) == {"web", "miniapp", "bot"}
    assert set(f["langs"]) == {"bg", "en", "ru"} and "spring" in f["campaigns"]
    assert "instagram" in f["sources"] and "utm" in f["source_kinds"]


def test_delete_visitor_removes_everything(seeded):
    a = next(i for i in seeded.users(D1, D3)["items"] if i["tg_id"] == 1)["visitor_id"]
    assert seeded.delete_visitor(a) is True
    assert seeded.delete_visitor(a) is False
    assert seeded.user_card(a) is None
    con = sqlite3.connect(seeded.path)
    assert con.execute("SELECT COUNT(*) FROM events WHERE visitor_id=?", (a,)).fetchone()[0] == 0
    assert con.execute("SELECT COUNT(*) FROM sessions WHERE visitor_id=?", (a,)).fetchone()[0] == 0
    con.close()
    assert metrics(seeded)["miniapp_opens"] == 0


def test_dedupe_events_and_sessions(store):
    s = Seed(store)
    src = s.source()
    v = s.anon_visitor("k", src, "2026-10-10T10:00:00Z")
    sid = uid()
    assert store.start_session(sid, v, "web", src, "bg", False, False, at("2026-10-10T10:00:00Z")) is True
    assert store.start_session(sid, v, "web", src, "bg", False, False, at("2026-10-10T11:00:00Z")) is False
    e = ev("site_open")
    assert store.add_events(sid, v, "web", [e]) == (1, 0)
    assert store.add_events(sid, v, "web", [e, ev("site_open")]) == (1, 1)
    con = sqlite3.connect(store.path)
    assert con.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 1
    assert con.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 2
    con.close()


def test_visitor_upsert_keeps_first_source_updates_profile(store):
    s = Seed(store)
    s1, s2 = s.source(kind="startapp", source="telegram", campaign="a"), s.source(kind="start", source="telegram", campaign="b")
    v1 = store.upsert_tg_visitor(tg(5, "Old", "oldname"), s1, at("2026-10-10T10:00:00Z"))
    v2 = store.upsert_tg_visitor(TelegramUser(5, "newname", "New", "Name", "bg", False), s2, at("2026-10-12T10:00:00Z"))
    assert v1 == v2 and v1.startswith("v_") and len(v1) == 22
    card = store.user_card(v1)
    assert card["username"] == "newname" and card["first_name"] == "New" and card["language"] == "bg"
    assert card["first_source"]["campaign"] == "a"
    assert card["first_seen"] == "2026-10-10T10:00:00Z" and card["last_seen"] == "2026-10-12T10:00:00Z"
    assert store.get_or_create_source(UNKNOWN) == store.get_or_create_source(UNKNOWN)


def test_retention_purge(store):
    s = Seed(store)
    src = s.source()
    v = s.anon_visitor("k", src, "2025-01-01T10:00:00Z")
    sid = s.session(v, "web", "2025-01-01T10:00:00Z", src)
    store.add_events(sid, v, "web", [ev("site_open", ts="2026-10-01T10:00:00Z")])
    cutoff = at("2026-10-18T00:00:00Z") - timedelta(days=13 * 31)
    assert store.purge_events_older_than(cutoff) == 1  # the 2025 open event
    assert store.user_card(v) is not None  # profile and session are kept
    assert len(store.user_card(v)["events"]) == 1


def _src_of(store, sid):
    con = sqlite3.connect(store.path)
    try:
        return con.execute("SELECT source_id, source_inherited FROM sessions WHERE id=?", (sid,)).fetchone()
    finally:
        con.close()


def test_inheritance_window_and_flag(store):
    s = Seed(store)
    camp, other, unk = s.source(kind="start", source="telegram", campaign="a"), \
        s.source(kind="utm", source="x"), s.source()
    v = s.tg_visitor(tg(9), unk, "2026-09-01T10:00:00Z")
    s.session(v, "bot", "2026-09-01T10:00:00Z", camp)
    s.session(v, "bot", "2026-09-02T10:00:00Z", other)
    # exactly 30 days after the latest known session: inherits the most recent known one
    sid = s.session(v, "miniapp", "2026-10-02T10:00:00Z", unk)
    assert _src_of(store, sid) == (other, 1)
    # 30 days + 1 second after the last known session: unknown, flag not set
    v3 = s.tg_visitor(tg(11), unk, "2026-09-01T10:00:00Z")
    s.session(v3, "bot", "2026-09-01T10:00:00Z", camp)
    sid2 = s.session(v3, "miniapp", "2026-10-01T10:00:01Z", unk)
    assert _src_of(store, sid2) == (unk, 0)
    # an own label wins
    sid3 = s.session(v, "miniapp", "2026-10-04T10:00:00Z", camp)
    assert _src_of(store, sid3) == (camp, 0)
    # a brand-new visitor has nothing to inherit
    v2 = s.tg_visitor(tg(10), unk, "2026-10-04T10:00:00Z")
    assert _src_of(store, s.session(v2, "bot", "2026-10-04T10:00:00Z", unk)) == (unk, 0)
    # inherited sessions count under the inherited source in the metrics filter
    m = store.metrics(date(2026, 10, 2), date(2026, 10, 2), source="x")
    assert m["sessions"] == 1


def test_inherited_session_does_not_extend_window(store):
    s = Seed(store)
    camp, unk = s.source(kind="start", source="telegram", campaign="a"), s.source()
    v = s.tg_visitor(tg(20), unk, "2026-09-01T10:00:00Z")
    s.session(v, "bot", "2026-09-01T10:00:00Z", camp)  # own label, day 0
    d20 = s.session(v, "miniapp", "2026-09-21T10:00:00Z", unk)
    d35 = s.session(v, "miniapp", "2026-10-06T10:00:00Z", unk)
    assert _src_of(store, d20) == (camp, 1)
    assert _src_of(store, d35) == (unk, 0)


def test_migration_v2_to_v3_in_place(tmp_path):
    path = tmp_path / "v2.sqlite3"
    AnalyticsStore(path)
    con = sqlite3.connect(path)
    con.execute("ALTER TABLE sessions DROP COLUMN source_inherited")
    con.execute("PRAGMA user_version = 2")
    con.execute("INSERT INTO sources(id, kind) VALUES (1, 'unknown')")
    con.execute("INSERT INTO visitors(id, kind, anon_key, first_seen, last_seen, first_source_id) "
                "VALUES ('v_a', 'anon', 'k', 't', 't', 1)")
    con.execute("INSERT INTO sessions(id, visitor_id, platform, started_at, last_at, source_id) "
                "VALUES ('s1', 'v_a', 'web', 't', 't', 1)")
    con.commit()
    con.close()
    st = AnalyticsStore(path)
    AnalyticsStore(path)  # idempotent
    con = sqlite3.connect(st.path)
    assert con.execute("PRAGMA user_version").fetchone()[0] == 3
    assert con.execute("SELECT source_inherited FROM sessions WHERE id='s1'").fetchone()[0] == 0
    con.close()


def test_schema_version_and_wal(store):
    con = sqlite3.connect(store.path)
    assert con.execute("PRAGMA user_version").fetchone()[0] == 3
    assert con.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    con.close()
    AnalyticsStore(store.path)  # re-open: migration is a no-op
