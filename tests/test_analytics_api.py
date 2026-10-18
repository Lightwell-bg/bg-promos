from __future__ import annotations

import dataclasses
import json
import logging
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from analytics_helpers import BOT_TOKEN, make_init_data, uid
from bg_promos.web.app import create_app

START = datetime(2026, 10, 18, 12, 0, tzinfo=timezone.utc)
PASSWORD = "correct horse"
UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1"


class Clock:
    def __init__(self) -> None:
        self.now = START

    def __call__(self) -> datetime:
        return self.now


def make(settings, **over):
    clock = Clock()
    cfg = dataclasses.replace(settings, analytics_secret="test-secret", admin_password=PASSWORD,
                              promos_bot_token=BOT_TOKEN, admin_cookie_secure=False, **over)
    app = create_app(cfg, now_fn=clock)
    return TestClient(app, headers={"user-agent": UA}), app, clock


@pytest.fixture
def api(settings):
    client, app, clock = make(settings)
    client.clock = clock
    client.svc = app.state.analytics
    client.cfg = settings
    return client


def web_session(client, **over) -> dict:
    body = {"session_id": uid(), "anon_id": uid(), "platform": "web", "lang": "bg", "utm": {}, "referrer": ""}
    body.update(over)
    r = client.post("/api/v1/analytics/session", json=body)
    assert r.status_code == 200, r.text
    return {**r.json(), "session_id": body["session_id"], "anon_id": body["anon_id"]}


def send(client, sess, events, token=None):
    return client.post("/api/v1/analytics/events", json={
        "token": token or sess["token"], "session_id": sess["session_id"], "events": events})


def event(name="catalog_loaded", props=None, clock=START, **kw):
    return {"event_id": uid(), "name": name, "ts": clock.isoformat(),
            "props": {"offers": 10, "from_cache": False} if props is None else props, **kw}


def rows(client, sql, *args):
    con = sqlite3.connect(client.cfg.analytics_db_path)
    try:
        return con.execute(sql, args).fetchall()
    finally:
        con.close()


def login(client) -> None:
    r = client.post("/api/admin/login", json={"password": PASSWORD})
    assert r.status_code == 200, r.text


# ---- config -------------------------------------------------------------------------------

def test_config_exposes_clarity_and_flag(settings):
    client, _, _ = make(settings, clarity_id="abc123xyz")
    body = client.get("/api/v1/config").json()
    assert body["clarity_id"] == "abc123xyz" and body["analytics_enabled"] is True
    client, _, _ = make(settings)
    assert client.get("/api/v1/config").json()["clarity_id"] is None


def test_analytics_disabled(settings):
    client, _, _ = make(settings, analytics_enabled=False)
    assert client.get("/api/v1/config").json()["analytics_enabled"] is False
    r = client.post("/api/v1/analytics/session", json={"session_id": uid(), "platform": "web", "anon_id": uid()})
    assert r.status_code == 404


# ---- sessions -----------------------------------------------------------------------------

def test_web_session_idempotent_and_hashed_anon_id(api):
    s1 = web_session(api)
    s2 = web_session(api, session_id=s1["session_id"], anon_id=s1["anon_id"])
    assert s1["visitor_id"] == s2["visitor_id"] and s1["token"] == s2["token"]
    assert s1["visitor_id"].startswith("v_")
    assert rows(api, "SELECT COUNT(*) FROM sessions")[0][0] == 1
    assert rows(api, "SELECT COUNT(*) FROM events WHERE name='site_open'")[0][0] == 1
    key = rows(api, "SELECT anon_key FROM visitors")[0][0]
    assert key != s1["anon_id"] and len(key) == 64
    assert rows(api, "SELECT COUNT(*) FROM visitors")[0][0] == 1
    # the same anonymous id in a new session is the same visitor
    s3 = web_session(api, anon_id=s1["anon_id"])
    assert s3["visitor_id"] == s1["visitor_id"]
    assert not api.cfg.db_path.exists()  # the catalog database is never touched


def test_session_validation(api):
    def post(**over):
        body = {"session_id": uid(), "anon_id": uid(), "platform": "web", **over}
        return api.post("/api/v1/analytics/session", json=body).status_code

    assert post(session_id="nope") == 400
    assert post(anon_id="nope") == 400
    assert post(anon_id=None) == 400
    assert post(platform="bot") == 400
    assert post(platform="miniapp") == 401  # no init_data
    assert api.post("/api/v1/analytics/session", content=b"{not json").status_code == 400
    # conflicting session id owned by another visitor
    s = web_session(api)
    other = {"session_id": s["session_id"], "anon_id": uid(), "platform": "web"}
    assert api.post("/api/v1/analytics/session", json=other).status_code == 409


def test_web_source_resolution_and_automated_flag(api):
    web_session(api, utm={"utm_source": "Instagram", "utm_campaign": "Autumn"})
    web_session(api, referrer="https://www.google.com/x")
    web_session(api, referrer="https://promos.centerai.eu/bg/")
    kinds = sorted(r[0] for r in rows(api, "SELECT kind FROM sources"))
    assert kinds == ["referrer", "unknown", "utm"]
    r = api.post("/api/v1/analytics/session", headers={"user-agent": "HeadlessChrome/120"},
                 json={"session_id": uid(), "anon_id": uid(), "platform": "web"})
    assert r.status_code == 200
    assert rows(api, "SELECT COUNT(*) FROM sessions WHERE is_automated=1")[0][0] == 1
    web_session(api, test=True)
    assert rows(api, "SELECT COUNT(*) FROM sessions WHERE is_test=1")[0][0] == 1


def miniapp(client, init_data, **over):
    return client.post("/api/v1/analytics/session", json={
        "session_id": uid(), "platform": "miniapp", "lang": "ru", "init_data": init_data, **over})


def test_miniapp_session_uses_verified_init_data(api):
    ts = int(START.timestamp()) - 60
    r = miniapp(api, make_init_data(auth_date=ts, start_param="s_spring-ig__c1_abc"),
                start_param="s_forged")  # the client-sent start_param is ignored
    assert r.status_code == 200
    card = api.svc.store.user_card(r.json()["visitor_id"])
    assert card["tg_id"] == 4242 and card["username"] == "ann_lee" and card["is_anonymous"] is False
    assert card["first_source"] == {"kind": "startapp", "source": "telegram", "medium": "miniapp",
                                    "campaign": "spring", "placement": "ig"}
    assert rows(api, "SELECT COUNT(*) FROM events WHERE name='miniapp_open'")[0][0] == 1
    # old cart-only startapp param: legacy share source
    r2 = miniapp(api, make_init_data(auth_date=ts, user={"id": 77, "first_name": "B"}, start_param="c1_xyz"))
    assert api.svc.store.user_card(r2.json()["visitor_id"])["first_source"] == {
        "kind": "startapp", "source": "telegram", "medium": "miniapp", "campaign": "share", "placement": "legacy"}
    # garbage start param: source unknown
    r3 = miniapp(api, make_init_data(auth_date=ts, user={"id": 78, "first_name": "C"}, start_param="garbage"))
    assert api.svc.store.user_card(r3.json()["visitor_id"])["first_source"]["kind"] == "unknown"


def test_miniapp_share_label_and_inheritance(api):
    ts = int(START.timestamp()) - 60
    r = miniapp(api, make_init_data(auth_date=ts, start_param="s_share-tg__c1_abc"))
    card = api.svc.store.user_card(r.json()["visitor_id"])
    assert card["first_source"]["campaign"] == "share" and card["first_source"]["placement"] == "tg"
    # plain re-open 2 days later inherits the share source
    api.clock.now = START + timedelta(days=2)
    r2 = miniapp(api, make_init_data(auth_date=int(api.clock.now.timestamp()) - 60))
    card = api.svc.store.user_card(r2.json()["visitor_id"])
    newest = card["sessions"][0]
    assert newest["source_inherited"] is True and newest["source"]["campaign"] == "share"


def test_web_session_inherits_within_30_days_only(api):
    anon = uid()
    web_session(api, anon_id=anon, utm={"utm_source": "ig", "utm_campaign": "autumn"})
    api.clock.now = START + timedelta(days=29)
    web_session(api, anon_id=anon)
    api.clock.now = START + timedelta(days=60)  # > 30 days after the last LABELED session
    web_session(api, anon_id=anon)
    res = rows(api, "SELECT src.kind, s.source_inherited FROM sessions s JOIN sources src ON src.id=s.source_id "
                    "ORDER BY s.started_at")
    assert res == [("utm", 0), ("utm", 1), ("unknown", 0)]
    # own label wins over inheritance
    api.clock.now = START + timedelta(days=61)
    web_session(api, anon_id=anon, utm={"utm_source": "fb"})
    assert rows(api, "SELECT src.source, s.source_inherited FROM sessions s JOIN sources src ON src.id=s.source_id "
                     "ORDER BY s.started_at DESC LIMIT 1") == [("fb", 0)]


def test_miniapp_rejects_forged_and_never_logs_init_data(api, caplog):
    caplog.set_level(logging.DEBUG)
    ts = int(START.timestamp()) - 60
    good = make_init_data(auth_date=ts, user={"id": 555123, "first_name": "Zorro"})
    assert miniapp(api, good.replace("555123", "555124")).status_code == 401
    assert miniapp(api, make_init_data(token="9:other-other-other-other-other-other-x", auth_date=ts)).status_code == 401
    assert miniapp(api, make_init_data(auth_date=ts - 90_000)).status_code == 401
    assert miniapp(api, make_init_data(auth_date=ts, drop_hash=True)).status_code == 401
    for bad in (good.replace("555123", "555124"), good):
        assert bad not in caplog.text
    assert "Zorro" not in caplog.text and "555123" not in caplog.text
    assert rows(api, "SELECT COUNT(*) FROM visitors")[0][0] == 0


# ---- events -------------------------------------------------------------------------------

def test_events_accept_dedupe_and_reject(api):
    s = web_session(api)
    good = event()
    bad = event("purchase", {})
    r = send(api, s, [good, bad, event("site_open", {}), event("search", {"len": 4, "results": 2, "query": "x"})])
    assert r.status_code == 200
    body = r.json()
    assert body["accepted"] == 1 and body["duplicates"] == 0
    assert [x["index"] for x in body["rejected"]] == [1, 2, 3]  # unknown, server-only, query with results
    again = send(api, s, [good]).json()
    assert again["accepted"] == 0 and again["duplicates"] == 1
    assert rows(api, "SELECT COUNT(*) FROM events WHERE name='catalog_loaded'")[0][0] == 1
    assert send(api, s, [bad]).status_code == 400  # nothing acceptable
    dup_in_batch = event()
    r = send(api, s, [dup_in_batch, dup_in_batch]).json()
    assert r["accepted"] == 1 and len(r["rejected"]) == 1


def test_events_token_checks(api):
    s1, s2 = web_session(api), web_session(api)
    assert send(api, s1, [event()], token="0" * 64).status_code == 401
    assert send(api, s1, [event()], token=s2["token"]).status_code == 401
    unknown = {"session_id": uid(), "token": s1["token"]}
    assert send(api, unknown, [event()]).status_code == 401
    assert api.post("/api/v1/analytics/events", json={"token": "x", "session_id": "bad", "events": []}).status_code == 400
    assert send(api, s1, [event()]).status_code == 200


def test_events_limits(api):
    s = web_session(api)
    assert send(api, s, [event() for _ in range(51)]).status_code == 400
    assert send(api, s, [event() for _ in range(50)]).status_code == 200
    big = {"token": s["token"], "session_id": s["session_id"], "events": [], "pad": "x" * 40_000}
    assert api.post("/api/v1/analytics/events", json=big).status_code == 413
    # chunked upload without Content-Length is limited by the actual size too
    def chunks():
        yield b'{"pad": "' + b"x" * 20_000
        yield b"x" * 20_000 + b'"}'
    assert api.post("/api/v1/analytics/events", content=chunks()).status_code == 413
    assert api.post("/api/v1/analytics/session", json={"pad": "x" * 40_000}).status_code == 413


def test_rate_limits(api):
    s = web_session(api)
    api.svc.session_limiter.limit = 3
    codes = [send(api, s, [event()]).status_code for _ in range(5)]
    assert codes == [200, 200, 200, 429, 429]
    api.svc.ip_limiter.limit = 2
    api.svc.ip_limiter._hits.clear()
    codes = [api.post("/api/v1/analytics/session",
                      json={"session_id": uid(), "anon_id": uid(), "platform": "web"}).status_code
             for _ in range(3)]
    assert codes == [200, 200, 429]


def test_empty_secret_generates_random_and_warns(settings, caplog):
    caplog.set_level(logging.WARNING)
    cfg = dataclasses.replace(settings, analytics_secret="", admin_password=PASSWORD)
    a, b = create_app(cfg), create_app(cfg)
    assert a.state.analytics.secret and a.state.analytics.secret != b.state.analytics.secret
    assert "reset on every restart" in caplog.text


# ---- retention ----------------------------------------------------------------------------

def test_retention_purge_once(api):
    s = web_session(api)
    old = (START - timedelta(days=500)).strftime("%Y-%m-%dT%H:%M:%SZ")
    api.svc.store.add_events(s["session_id"], s["visitor_id"], "web",
                             [{"event_id": uid(), "name": "site_open", "ts": old, "props": {}}])
    assert api.svc.purge_once() == 1
    assert rows(api, "SELECT COUNT(*) FROM events")[0][0] == 1  # the fresh site_open stays
    assert rows(api, "SELECT COUNT(*) FROM visitors")[0][0] == 1


# ---- admin --------------------------------------------------------------------------------

ADMIN_GETS = ["/api/admin/metrics", "/api/admin/users", "/api/admin/filters", "/api/admin/users/v_x"]


def test_admin_disabled_when_password_empty(settings):
    cfg = dataclasses.replace(settings, admin_password="", analytics_secret="s")
    client = TestClient(create_app(cfg))
    assert client.post("/api/admin/login", json={"password": ""}).status_code == 404
    assert client.post("/api/admin/logout").status_code == 404
    for path in ADMIN_GETS:
        assert client.get(path).status_code == 404
    assert client.delete("/api/admin/users/v_x").status_code == 404


def test_admin_requires_cookie(api):
    for path in ADMIN_GETS:
        r = api.get(path)
        assert r.status_code == 401 and r.headers["cache-control"] == "no-store"
    assert api.delete("/api/admin/users/v_x").status_code == 401


def test_admin_login_cookie_flags_and_session(api, settings):
    r = api.post("/api/admin/login", json={"password": PASSWORD})
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    cookie = r.headers["set-cookie"].lower()
    assert "bgp_admin=" in cookie and "httponly" in cookie and "samesite=strict" in cookie
    assert "path=/api/admin" in cookie and "max-age=43200" in cookie and "secure" not in cookie
    assert api.get("/api/admin/metrics").status_code == 200
    assert PASSWORD not in r.text
    secure_app = create_app(dataclasses.replace(settings, analytics_secret="k", admin_password=PASSWORD))
    r = TestClient(secure_app).post("/api/admin/login", json={"password": PASSWORD})
    assert "secure" in r.headers["set-cookie"].lower()


def test_admin_wrong_password_and_rate_limit(api):
    for _ in range(5):
        r = api.post("/api/admin/login", json={"password": "nope"})
        assert r.status_code == 401
    # locked out, even with the right password
    assert api.post("/api/admin/login", json={"password": PASSWORD}).status_code == 429
    assert api.get("/api/admin/metrics").status_code == 401
    # window passes -> allowed again
    api.svc.login_limiter._hits.clear()
    assert api.post("/api/admin/login", json={"password": PASSWORD}).status_code == 200


def test_admin_cookie_tampered_expired_and_logout(api):
    login(api)
    value = api.cookies.get("bgp_admin")
    expiry, _, mac = value.partition(".")
    for forged in (f"{int(expiry) + 99999}.{mac}", f"{expiry}.{'0' * 64}", "garbage", f".{mac}"):
        api.cookies.clear()
        api.cookies.set("bgp_admin", forged, path="/api/admin")
        assert api.get("/api/admin/metrics").status_code == 401
    api.cookies.clear()
    api.cookies.set("bgp_admin", value, path="/api/admin")
    assert api.get("/api/admin/metrics").status_code == 200
    api.clock.now = START + timedelta(hours=12, seconds=1)
    assert api.get("/api/admin/metrics").status_code == 401
    api.clock.now = START
    r = api.post("/api/admin/logout")
    set_cookie = r.headers["set-cookie"].lower()
    assert r.status_code == 200 and "bgp_admin=" in set_cookie and "max-age=0" in set_cookie
    assert "path=/api/admin" in set_cookie
    api.cookies.clear()  # what the browser does with the deletion
    assert api.get("/api/admin/metrics").status_code == 401


def test_admin_cookie_signed_with_secret(api, settings):
    login(api)
    value = api.cookies.get("bgp_admin")
    cfg2 = dataclasses.replace(settings, analytics_secret="different", admin_password=PASSWORD,
                               admin_cookie_secure=False)
    c2 = TestClient(create_app(cfg2, now_fn=api.clock))
    c2.cookies.set("bgp_admin", value, path="/api/admin")
    assert c2.get("/api/admin/metrics").status_code == 401


def test_admin_data_endpoints(api):
    ts = int(START.timestamp()) - 60
    tg = miniapp(api, make_init_data(auth_date=ts, start_param="s_spring")).json()
    web = web_session(api, utm={"utm_source": "ig", "utm_campaign": "autumn"})
    assert send(api, web, [event("cart_add", {"offer_id": "o1", "chain": "lidl", "category": "dairy"})]).status_code == 200
    login(api)

    m = api.get("/api/admin/metrics", params={"from": "2026-10-18", "to": "2026-10-18"}).json()
    assert m["users"] == {"total": 2, "tg": 1, "anon": 1} and m["sessions"] == 2
    assert m["miniapp_opens"] == 1 and m["site_opens"] == 1 and m["cart_add_users"] == 1
    assert api.get("/api/admin/metrics", params={"platform": "miniapp"}).json()["users"]["total"] == 1
    assert api.get("/api/admin/metrics", params={"campaign": "autumn"}).json()["users"]["total"] == 1
    # defaults to the last 7 Sofia days ending today
    assert api.get("/api/admin/metrics").json()["period"] == {"from": "2026-10-12", "to": "2026-10-18"}
    for bad in ({"from": "x"}, {"from": "2026-10-19", "to": "2026-10-18"}, {"from": "2020-01-01"}):
        assert api.get("/api/admin/metrics", params=bad).status_code == 400

    users = api.get("/api/admin/users", params={"from": "2026-10-18", "to": "2026-10-18"}).json()
    assert users["total"] == 2
    found = api.post("/api/admin/users/search", json={"q": "ann", "from": "2026-10-18", "to": "2026-10-18"}).json()
    assert [i["tg_id"] for i in found["items"]] == [4242]
    assert api.get("/api/admin/users", params={"limit": 0}).status_code == 400

    flt = api.get("/api/admin/filters").json()
    assert "miniapp" in flt["platforms"] and "autumn" in flt["campaigns"]

    card = api.get(f"/api/admin/users/{tg['visitor_id']}").json()
    assert card["tg_id"] == 4242 and card["is_anonymous"] is False
    anon = api.get(f"/api/admin/users/{web['visitor_id']}").json()
    assert anon["is_anonymous"] is True and anon["tg_id"] is None
    assert api.get("/api/admin/users/v_missing").status_code == 404

    r = api.delete(f"/api/admin/users/{web['visitor_id']}")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    assert api.get(f"/api/admin/users/{web['visitor_id']}").status_code == 404
    assert api.delete(f"/api/admin/users/{web['visitor_id']}").status_code == 404
    assert rows(api, "SELECT COUNT(*) FROM events WHERE visitor_id=?", web["visitor_id"])[0][0] == 0


def test_admin_not_cors_enabled_for_foreign_origin(api):
    r = api.options("/api/admin/metrics", headers={
        "Origin": "https://evil.example", "Access-Control-Request-Method": "DELETE"})
    assert "access-control-allow-origin" not in r.headers
    assert "access-control-allow-credentials" not in r.headers


def test_json_roundtrip_of_props(api):
    s = web_session(api)
    send(api, s, [event("search", {"len": 5, "results": 0, "query": "  МЛЯКО  "})])
    props = json.loads(rows(api, "SELECT props FROM events WHERE name='search'")[0][0])
    assert props["query"] == "мляко"
