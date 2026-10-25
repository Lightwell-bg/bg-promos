from __future__ import annotations

import dataclasses
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from bg_promos.config import ChainSettings
from bg_promos.control import ControlStore
from bg_promos.storage import Storage
from bg_promos.web.app import create_app

PASSWORD = "correct horse"
NOW = datetime(2026, 10, 25, 12, 0, tzinfo=timezone.utc)  # 15:00 Sofia (EEST fell back at 04:00 UTC: UTC+2)


def iso(d: datetime) -> str:
    return d.isoformat(timespec="seconds")


@pytest.fixture
def api(settings):
    cfg = dataclasses.replace(settings, analytics_secret="test-secret", admin_password=PASSWORD,
                              admin_cookie_secure=False)
    client = TestClient(create_app(cfg, now_fn=lambda: NOW))
    client.cfg = cfg
    return client


@pytest.fixture
def admin(api):
    assert api.post("/api/admin/login", json={"password": PASSWORD}).status_code == 200
    return api


def add_run(settings, chain, started: datetime, status="ok", offers=10, active=8, seconds=30, error=None):
    with Storage(settings.db_path) as st:
        rid = st.start_run(chain, scheduled=True)
        st.finish_run(rid, status, offers, error=error)
        st.conn.execute(
            "UPDATE scrape_runs SET started_at = ?, finished_at = ?, active_count = ? WHERE id = ?",
            (iso(started), iso(started + timedelta(seconds=seconds)), active, rid),
        )
        st.conn.commit()
    return rid


def chain_of(body, name):
    return next(c for c in body["chains"] if c["chain"] == name)


ENDPOINTS = [
    ("get", "/api/admin/collection"),
    ("get", "/api/admin/collection/runs"),
    ("put", "/api/admin/collection/schedule/lidl"),
    ("delete", "/api/admin/collection/schedule/lidl?revision=0"),
    ("post", "/api/admin/collection/run/lidl"),
]


@pytest.mark.parametrize("method,url", ENDPOINTS)
def test_requires_admin_cookie(api, method, url):
    assert getattr(api, method)(url).status_code == 401


def test_admin_disabled_is_404(settings):
    cfg = dataclasses.replace(settings, analytics_secret="s", admin_password="")
    assert TestClient(create_app(cfg)).get("/api/admin/collection").status_code == 404


def test_get_shape_and_stats_math(admin):
    cfg = admin.cfg
    add_run(cfg, "lidl", NOW - timedelta(days=1), "ok", offers=10, seconds=20)
    add_run(cfg, "lidl", NOW - timedelta(days=2), "ok", offers=20, seconds=40)
    add_run(cfg, "lidl", NOW - timedelta(days=3), "failed", offers=None, seconds=10, error="X" * 500)
    add_run(cfg, "lidl", NOW - timedelta(days=4), "suspicious", offers=3)
    add_run(cfg, "lidl", NOW - timedelta(days=20), "ok", offers=99)  # outside 7 days
    with ControlStore(cfg.control_db_path) as c:
        c.request_run("lidl", NOW)
    r = admin.get("/api/admin/collection")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    body = r.json()
    assert (body["tz"], body["cron"], body["now"]) == ("Europe/Sofia", "hourly at :00", iso(NOW))
    assert [c["chain"] for c in body["chains"]] == ["lidl", "kaufland", "billa"]
    lidl = chain_of(body, "lidl")
    p = lidl["period"]
    assert (p["runs"], p["ok"], p["failed"], p["suspicious"], p["running"]) == (4, 2, 1, 1, 0)
    assert p["success_rate"] == 0.5
    assert p["avg_offers"] == 15.0
    assert p["avg_duration_s"] == round((20 + 40 + 10 + 30) / 4, 1)
    assert [x["status"] for x in lidl["series"]] == ["suspicious", "failed", "ok", "ok"]  # oldest first
    assert lidl["last_run"]["status"] == "ok" and lidl["last_run"]["duration_s"] == 20.0
    assert lidl["last_ok_at"] == iso(NOW - timedelta(days=1) + timedelta(seconds=20))
    assert lidl["stale"] is False  # 36 h limit, last ok is ~1 day old
    assert lidl["schedule"] == {"enabled": True, "slots": ["06:30", "12:30", "18:30"], "source": "config",
                                "revision": 0, "updated_at": None}
    assert lidl["config_slots"] == ["06:30", "12:30", "18:30"] and lidl["config_enabled"] is True
    assert lidl["next_slot_at"] == iso(datetime(2026, 10, 25, 16, 30, tzinfo=timezone.utc))
    assert lidl["pending_request"]["requested_at"] == iso(NOW) and lidl["last_request"]["status"] is None
    kaufland = chain_of(body, "kaufland")
    assert kaufland["last_run"] is None and kaufland["stale"] is True
    assert kaufland["period"]["success_rate"] is None and kaufland["period"]["avg_duration_s"] is None
    assert "recent_runs" not in body
    assert len(admin.get("/api/admin/collection?days=30").json()["chains"][0]["series"]) == 5


def test_runs_shape_order_and_filters(admin):
    cfg = admin.cfg
    add_run(cfg, "lidl", NOW - timedelta(days=1), "ok", offers=10)
    add_run(cfg, "lidl", NOW - timedelta(days=3), "failed", offers=None, error="X" * 500)
    add_run(cfg, "kaufland", NOW - timedelta(days=2), "suspicious", offers=3)
    add_run(cfg, "lidl", NOW - timedelta(days=20), "ok")  # outside 7 days
    r = admin.get("/api/admin/collection/runs")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    body = r.json()
    assert (body["total"], body["limit"], body["offset"]) == (3, 20, 0)
    items = body["items"]
    assert [i["status"] for i in items] == ["ok", "suspicious", "failed"]  # newest first
    failed = items[2]
    assert len(failed["error"]) == 300
    assert {"id", "chain", "started_at", "finished_at", "status", "scheduled", "offers_count",
            "active_count", "content_changed", "error", "duration_s"} <= set(failed)
    assert admin.get("/api/admin/collection/runs?days=30").json()["total"] == 4
    by_chain = admin.get("/api/admin/collection/runs?chain=kaufland").json()
    assert by_chain["total"] == 1 and by_chain["items"][0]["chain"] == "kaufland"
    by_status = admin.get("/api/admin/collection/runs?status=failed&chain=lidl").json()
    assert by_status["total"] == 1 and by_status["items"][0]["status"] == "failed"
    assert admin.get("/api/admin/collection/runs?status=running").json() == {
        "items": [], "total": 0, "limit": 20, "offset": 0}
    assert admin.get("/api/admin/collection/runs?chain=&status=").json()["total"] == 3


def test_runs_paging_math(admin):
    for i in range(25):
        add_run(admin.cfg, "lidl", NOW - timedelta(hours=i + 1))
    p1 = admin.get("/api/admin/collection/runs?limit=10&offset=0").json()
    p2 = admin.get("/api/admin/collection/runs?limit=10&offset=10").json()
    p3 = admin.get("/api/admin/collection/runs?limit=10&offset=20").json()
    assert p1["total"] == p2["total"] == p3["total"] == 25
    assert (len(p1["items"]), len(p2["items"]), len(p3["items"])) == (10, 10, 5)
    ids = [i["id"] for p in (p1, p2, p3) for i in p["items"]]
    assert ids == list(range(1, 26))  # run i started i hours ago: newest (id 1) first, no gaps or repeats
    beyond = admin.get("/api/admin/collection/runs?limit=10&offset=500")
    assert beyond.status_code == 200 and beyond.json()["items"] == [] and beyond.json()["total"] == 25
    assert len(admin.get("/api/admin/collection/runs?limit=100").json()["items"]) == 25


def test_runs_same_started_at_is_stable(admin):
    t = NOW - timedelta(hours=1)
    ids = [add_run(admin.cfg, "lidl", t) for _ in range(4)]
    got = [i["id"] for i in admin.get("/api/admin/collection/runs").json()["items"]]
    assert got == sorted(ids, reverse=True)


@pytest.mark.parametrize("query", [
    "days=1", "days=abc", "status=bogus", "limit=0", "limit=101", "limit=x", "limit=-1", "limit=",
    "offset=-1", "offset=x", "offset=",
])
def test_runs_validation_422(admin, query):
    assert admin.get(f"/api/admin/collection/runs?{query}").status_code == 422


def test_runs_unknown_chain_404(admin):
    assert admin.get("/api/admin/collection/runs?chain=nope").status_code == 404


def test_runs_missing_catalog_db_is_empty(admin):
    assert not admin.cfg.db_path.exists()
    r = admin.get("/api/admin/collection/runs")
    assert r.status_code == 200
    assert r.json() == {"items": [], "total": 0, "limit": 20, "offset": 0}
    assert not admin.cfg.db_path.exists()


def test_stale_when_last_ok_is_old(admin):
    add_run(admin.cfg, "billa", NOW - timedelta(hours=40))
    assert chain_of(admin.get("/api/admin/collection").json(), "billa")["stale"] is True


@pytest.mark.parametrize("days", ["0", "1", "14", "abc", "-7", ""])
def test_days_validation(admin, days):
    assert admin.get(f"/api/admin/collection?days={days}").status_code == 422


def test_missing_catalog_db_gives_empty_stats(admin):
    assert not admin.cfg.db_path.exists()
    r = admin.get("/api/admin/collection")
    assert r.status_code == 200
    body = r.json()
    assert "recent_runs" not in body and len(body["chains"]) == 3
    assert all(c["last_run"] is None and c["period"]["runs"] == 0 for c in body["chains"])
    assert not admin.cfg.db_path.exists()  # the API must not create the catalog DB


def test_put_schedule_flow(admin):
    url = "/api/admin/collection/schedule/lidl"
    r = admin.put(url, json={"enabled": True, "slots": ["09:00", "07:30", "09:00"], "revision": 0})
    assert r.status_code == 200
    sched = r.json()
    assert (sched["slots"], sched["source"], sched["revision"], sched["enabled"]) == (["07:30", "09:00"], "admin", 1, True)
    stale = admin.put(url, json={"enabled": True, "slots": ["10:00"], "revision": 0})
    assert stale.status_code == 409
    assert stale.json()["detail"] == "stale" and stale.json()["current"]["revision"] == 1
    body = admin.get("/api/admin/collection").json()
    assert chain_of(body, "lidl")["schedule"]["slots"] == ["07:30", "09:00"]
    assert chain_of(body, "lidl")["config_slots"] == ["06:30", "12:30", "18:30"]
    off = admin.put(url, json={"enabled": False, "slots": [], "revision": 1})
    assert off.status_code == 200 and off.json()["enabled"] is False
    assert chain_of(admin.get("/api/admin/collection").json(), "lidl")["next_slot_at"] is None


@pytest.mark.parametrize("payload", [
    {"enabled": True, "slots": [], "revision": 0},
    {"enabled": True, "slots": ["25:00"], "revision": 0},
    {"enabled": True, "slots": ["7:30"], "revision": 0},
    {"enabled": True, "slots": [f"{h:02d}:00" for h in range(24)] + ["00:30"], "revision": 0},
    {"enabled": "yes", "slots": ["07:30"], "revision": 0},
    {"enabled": True, "slots": "07:30", "revision": 0},
    {"enabled": True, "slots": ["07:30"], "revision": -1},
    {"enabled": True, "slots": ["07:30"]},
    [],
])
def test_put_validation_422(admin, payload):
    assert admin.put("/api/admin/collection/schedule/lidl", json=payload).status_code == 422
    assert not admin.cfg.control_db_path.exists() or ControlStore(admin.cfg.control_db_path).all_schedules() == []


def test_put_delete_post_unknown_chain_404(admin):
    assert admin.put("/api/admin/collection/schedule/nope",
                     json={"enabled": True, "slots": ["07:30"], "revision": 0}).status_code == 404
    assert admin.delete("/api/admin/collection/schedule/nope?revision=0").status_code == 404
    assert admin.post("/api/admin/collection/run/nope").status_code == 404


def test_config_disabled_chain_is_409(settings):
    cfg = dataclasses.replace(
        settings, analytics_secret="k", admin_password=PASSWORD, admin_cookie_secure=False,
        chains={**settings.chains, "billa": ChainSettings(False)})
    client = TestClient(create_app(cfg, now_fn=lambda: NOW))
    client.post("/api/admin/login", json={"password": PASSWORD})
    assert client.put("/api/admin/collection/schedule/billa",
                      json={"enabled": True, "slots": ["07:30"], "revision": 0}).status_code == 409
    assert client.delete("/api/admin/collection/schedule/billa?revision=0").status_code == 409
    assert client.post("/api/admin/collection/run/billa").status_code == 409
    billa = chain_of(client.get("/api/admin/collection").json(), "billa")
    assert billa["config_enabled"] is False and billa["next_slot_at"] is None


def test_delete_resets_to_config(admin):
    url = "/api/admin/collection/schedule/kaufland"
    admin.put(url, json={"enabled": False, "slots": [], "revision": 0})
    assert admin.delete(url + "?revision=0").status_code == 409  # stale
    r = admin.delete(url + "?revision=1")
    assert r.status_code == 200
    assert (r.json()["source"], r.json()["enabled"], r.json()["revision"]) == ("config", True, 2)
    assert r.json()["slots"] == ["06:30", "12:30", "18:30"]
    assert admin.delete(url).status_code == 422
    assert admin.delete(url + "?revision=x").status_code == 422
    assert admin.delete(url + "?revision=1").status_code == 409  # old tab cannot reset again


def test_run_request_dedupe(admin):
    url = "/api/admin/collection/run/billa"
    first = admin.post(url)
    assert first.status_code == 202 and first.json()["created"] is True
    second = admin.post(url)
    assert second.status_code == 200 and second.json()["created"] is False
    assert second.json()["request"]["id"] == first.json()["request"]["id"]
    pending = chain_of(admin.get("/api/admin/collection").json(), "billa")["pending_request"]
    assert pending["id"] == first.json()["request"]["id"]
    with ControlStore(admin.cfg.control_db_path) as c:
        assert c.claim_request(pending["id"], NOW)
    assert admin.post(url).status_code == 202  # after the claim a new request is allowed
