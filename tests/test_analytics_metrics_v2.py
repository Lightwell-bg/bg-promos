"""Admin metrics v2: previous period, series, funnel, sources, platforms, new/returning, noise flag."""

from __future__ import annotations

from datetime import date

import pytest

from analytics_helpers import uid
from bg_promos.analytics.store import AnalyticsStore
from test_analytics_store import O1, O2, ERR_DETAIL, Seed, at, ev, store, tg  # noqa: F401

DAY = date(2026, 10, 18)
PREV = date(2026, 10, 17)
CATALOG = {"offers": 10, "from_cache": False}
SHARE = {"lines": 1, "telegram": True}


@pytest.fixture
def data(store) -> AnalyticsStore:
    s = Seed(store)
    app = s.source(kind="startapp", source="telegram", medium="miniapp", campaign="spring")
    utm = s.source(kind="utm", source="instagram", medium="social", campaign="autumn")
    unk = s.source()
    # a: new on DAY (Telegram, spring), full funnel; 09:00Z = 12:00 Sofia
    a = s.tg_visitor(tg(1), app, "2026-10-18T09:00:00Z")
    s.session(a, "miniapp", "2026-10-18T09:00:00Z", app, "ru", [
        ev("catalog_loaded", CATALOG), ev("offer_view", O1), ev("cart_add", O1), ev("share_link_created", SHARE)])
    # b: first seen on PREV (utm), active on both days -> returning on DAY
    b = s.anon_visitor("key-b", utm, "2026-10-17T10:00:00Z")
    s.session(b, "web", "2026-10-17T10:00:00Z", utm, "bg", [ev("catalog_loaded", CATALOG)])
    s.session(b, "web", "2026-10-18T10:00:00Z", utm, "bg", [
        ev("catalog_loaded", CATALOG), ev("offer_view", O2),
        ev("app_error", {**ERR_DETAIL, "name": "ScriptError", "source": "own"}),
        ev("app_error", {**ERR_DETAIL, "name": "RangeError", "source": "external"}),
        ev("app_error", ERR_DETAIL)])
    # c: new on DAY, unknown source, only opened
    c = s.anon_visitor("key-c", unk, "2026-10-18T11:00:00Z")
    s.session(c, "web", "2026-10-18T11:00:00Z", unk, "bg")
    # f: only on PREV (Telegram, spring) with a cart add
    f = s.tg_visitor(tg(2), app, "2026-10-17T08:00:00Z")
    s.session(f, "miniapp", "2026-10-17T08:00:00Z", app, "ru", [ev("cart_add", O1)])
    # test and automated traffic: excluded by default
    t = s.anon_visitor("key-t", utm, "2026-10-18T12:00:00Z")
    s.session(t, "web", "2026-10-18T12:00:00Z", utm, "bg", [ev("cart_add", O1)], test=True)
    r = s.anon_visitor("key-r", utm, "2026-10-18T12:00:00Z")
    s.session(r, "web", "2026-10-18T12:00:00Z", utm, "bg", [ev("cart_add", O1)], automated=True)
    return store


def test_previous_range():
    pr = AnalyticsStore.previous_range
    assert pr(date(2026, 10, 18), date(2026, 10, 18)) == (date(2026, 10, 17), date(2026, 10, 17))
    assert pr(date(2026, 10, 12), date(2026, 10, 18)) == (date(2026, 10, 5), date(2026, 10, 11))
    # month boundary: 7 days ending 3 Nov -> the 7 days before, in October
    assert pr(date(2026, 10, 28), date(2026, 11, 3)) == (date(2026, 10, 21), date(2026, 10, 27))
    assert pr(date(2026, 3, 1), date(2026, 3, 1)) == (date(2026, 2, 28), date(2026, 2, 28))


def test_previous_kpi_and_range(data):
    m = data.metrics(DAY, DAY)
    assert m["previous_range"] == {"from": "2026-10-17", "to": "2026-10-17"}
    p = m["previous"]
    assert p["period"] == {"from": "2026-10-17", "to": "2026-10-17"}
    assert p["users"] == {"total": 2, "tg": 1, "anon": 1}
    assert (p["sessions"], p["catalog_loads"], p["cart_add_users"]) == (2, 1, 1)
    assert "top_offers" not in p and "errors" not in p
    # with the same filters: platform=web leaves only b on the previous day
    assert data.metrics(DAY, DAY, platform="web")["previous"]["users"]["total"] == 1


def test_new_vs_returning(data):
    m = data.metrics(DAY, DAY)
    assert m["users"]["total"] == 3
    assert (m["new_users"], m["returning_users"]) == (2, 1)  # a, c new; b returning
    p = m["previous"]
    assert (p["new_users"], p["returning_users"]) == (2, 0)


def test_default_excludes_test_and_automated(data):
    assert data.metrics(DAY, DAY)["users"]["total"] == 3
    m = data.metrics(DAY, DAY, include_test=True, include_automated=True)
    assert m["users"]["total"] == 5
    assert m["funnel"]["current"]["cart_add"] == 3
    assert sum(p["users"] for p in m["platforms"]) == 5


def test_hour_series(data):
    m = data.metrics(DAY, DAY)
    s = m["series"]
    assert s["bucket"] == "hour" and len(s["points"]) == 24 and len(s["previous_points"]) == 24
    assert s["points"][12]["t"] == "2026-10-18T12:00:00+03:00"
    assert s["points"][12]["miniapp_opens"] == 1 and s["points"][12]["cart_users"] == 1
    assert s["points"][12]["users"] == 1 and s["points"][12]["sessions"] == 1
    assert s["points"][13]["site_opens"] == 1  # b at 10:00Z = 13:00
    assert s["points"][14]["site_opens"] == 1  # c at 11:00Z = 14:00
    assert sum(p["users"] for p in s["points"]) == 3
    assert s["points"][0]["users"] == 0  # empty buckets are present with zeros
    prev = s["previous_points"]
    assert prev[11]["miniapp_opens"] == 1 and prev[11]["cart_users"] == 1  # f 08:00Z = 11:00
    assert prev[13]["site_opens"] == 1 and prev[13]["t"] == "2026-10-17T13:00:00+03:00"


def test_hour_buckets_dst_days(store):
    m = store.metrics(date(2026, 10, 25), date(2026, 10, 25))
    pts = m["series"]["points"]
    assert len(pts) == 25
    assert pts[0]["t"] == "2026-10-25T00:00:00+03:00" and pts[-1]["t"] == "2026-10-25T23:00:00+02:00"
    assert len(m["series"]["previous_points"]) == 25  # previous (24 h) padded with zeros
    assert m["series"]["previous_points"][24]["users"] == 0
    # 2027-03-28: 23 hours; previous day (24 h) truncated
    m = store.metrics(date(2027, 3, 28), date(2027, 3, 28))
    assert len(m["series"]["points"]) == 23 and len(m["series"]["previous_points"]) == 23
    # the day after the change: previous (25 h) truncated to 24
    m = store.metrics(date(2026, 10, 26), date(2026, 10, 26))
    assert len(m["series"]["points"]) == 24 and len(m["series"]["previous_points"]) == 24


def test_events_land_in_dst_hours(store):
    s = Seed(store)
    src = s.source()
    v = s.anon_visitor("k", src, "2026-10-25T00:30:00Z")
    # 2026-10-25T01:30Z = 03:30 EET (after the change), 00:30Z = 03:30 EEST (before): two different buckets
    s.session(v, "web", "2026-10-25T00:30:00Z", src)
    s.session(v, "web", "2026-10-25T01:30:00Z", src)
    pts = store.metrics(date(2026, 10, 25), date(2026, 10, 25))["series"]["points"]
    assert [p["t"] for p in pts if p["sessions"]] == ["2026-10-25T03:00:00+03:00", "2026-10-25T03:00:00+02:00"]


def test_day_series(data):
    m = data.metrics(date(2026, 10, 17), DAY)
    s = m["series"]
    assert s["bucket"] == "day" and len(s["points"]) == 2
    assert s["points"][0]["t"] == "2026-10-17T00:00:00+03:00"
    assert [p["users"] for p in s["points"]] == [2, 3]
    assert m["previous_range"] == {"from": "2026-10-15", "to": "2026-10-16"}
    assert [p["users"] for p in s["previous_points"]] == [0, 0]
    assert len(s["previous_points"]) == 2


def test_funnel(data):
    m = data.metrics(DAY, DAY)
    assert m["funnel"]["current"] == {
        "opened": 3, "catalog_loaded": 2, "offer_view": 2, "cart_add": 1, "share_link_created": 1}
    assert m["funnel"]["previous"] == {
        "opened": 2, "catalog_loaded": 1, "offer_view": 0, "cart_add": 1, "share_link_created": 0}


def test_sources_with_previous_and_new(data):
    rows = data.metrics(DAY, DAY)["sources"]
    by = {(r["kind"], r["source"], r["campaign"]): r for r in rows}
    assert set(by) == {("startapp", "telegram", "spring"), ("utm", "instagram", "autumn"), ("unknown", None, None)}
    tgs = by[("startapp", "telegram", "spring")]
    assert (tgs["users"], tgs["sessions"], tgs["cart_users"], tgs["new_users"], tgs["previous_users"]) == (1, 1, 1, 1, 1)
    utm = by[("utm", "instagram", "autumn")]
    assert (utm["users"], utm["cart_users"], utm["new_users"], utm["previous_users"]) == (1, 0, 0, 1)
    unk = by[("unknown", None, None)]
    assert (unk["users"], unk["new_users"], unk["previous_users"]) == (1, 1, 0)
    assert [r["users"] for r in rows] == sorted((r["users"] for r in rows), reverse=True)


def test_sources_keep_cart_users_of_session_started_before_period(store):
    s = Seed(store)
    app = s.source(kind="startapp", source="telegram", medium="miniapp", campaign="spring")
    v = s.tg_visitor(tg(7), app, "2026-10-17T20:55:00Z")
    # session starts 2026-10-17 23:55 Sofia (20:55Z), cart_add at 2026-10-18 00:05 Sofia (21:05Z)
    sid = s.session(v, "miniapp", "2026-10-17T20:55:00Z", app, "ru")
    store.add_events(sid, v, "miniapp", [ev("cart_add", O1, ts="2026-10-17T21:05:00Z")])
    m = store.metrics(DAY, DAY)
    assert m["cart_add_users"] == 1
    rows = m["sources"]
    assert len(rows) == 1
    assert (rows[0]["kind"], rows[0]["users"], rows[0]["sessions"], rows[0]["cart_users"]) == (
        "startapp", 0, 0, 1)
    assert rows[0]["previous_users"] == 1


def test_platforms(data):
    rows = {r["platform"]: r for r in data.metrics(DAY, DAY)["platforms"]}
    assert set(rows) == {"web", "miniapp", "bot"}
    assert (rows["web"]["users"], rows["web"]["sessions"]) == (2, 2)
    assert (rows["web"]["previous_users"], rows["web"]["previous_sessions"]) == (1, 1)
    assert (rows["miniapp"]["users"], rows["miniapp"]["previous_users"]) == (1, 1)
    assert (rows["bot"]["users"], rows["bot"]["previous_users"]) == (0, 0)


def test_error_noise_flag(data):
    errs = {e["name"] + "/" + str(e["source"]): e["noise"] for e in data.metrics(DAY, DAY)["errors"]}
    assert errs == {"ScriptError/own": True, "RangeError/external": True, "RangeError/own": False}


def test_filters_apply_to_all_blocks(data):
    m = data.metrics(DAY, DAY, source_kind="utm")
    assert m["users"]["total"] == 1 and m["previous"]["users"]["total"] == 1
    assert (m["new_users"], m["returning_users"]) == (0, 1)
    assert m["funnel"]["current"] == {
        "opened": 1, "catalog_loaded": 1, "offer_view": 1, "cart_add": 0, "share_link_created": 0}
    assert m["funnel"]["previous"]["opened"] == 1 and m["funnel"]["previous"]["catalog_loaded"] == 1
    assert sum(p["users"] for p in m["series"]["points"]) == 1
    assert sum(p["users"] for p in m["series"]["previous_points"]) == 1
    assert [(r["kind"], r["users"]) for r in m["sources"]] == [("utm", 1)]
    assert {p["platform"]: p["users"] for p in m["platforms"]} == {"web": 1, "miniapp": 0, "bot": 0}
    m = data.metrics(DAY, DAY, platform="miniapp", lang="ru")
    assert m["users"]["total"] == 1 and m["previous"]["users"]["total"] == 1
    assert [r["kind"] for r in m["sources"]] == ["startapp"]
    assert m["funnel"]["current"]["share_link_created"] == 1
