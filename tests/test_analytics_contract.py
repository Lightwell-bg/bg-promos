"""Contract test: the JSON shapes of the analytics API (keys + types).

The frontend mocks live in web/src/__fixtures__/admin/*.json and are asserted here against
the real responses, so a backend shape change fails this test until the fixtures (and the
frontend client web/src/data/adminApi.ts) are updated.
"""

from __future__ import annotations

import json
from pathlib import Path

from analytics_helpers import make_init_data
from test_analytics_api import START, api, event, login, miniapp, send, web_session  # noqa: F401

FIXTURES = Path(__file__).resolve().parents[1] / "web" / "src" / "__fixtures__" / "admin"
FREE_DICTS = {"props"}  # event props differ per event name: only "is an object" is checked


def fixture(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def conforms(sample, actual, path: str = "$") -> list[str]:
    """Differences between a fixture and a real response (None matches any type: nullable)."""
    if sample is None or actual is None:
        return []
    if isinstance(sample, dict) and isinstance(actual, dict):
        out = []
        if set(sample) != set(actual):
            out.append(f"{path}: keys {sorted(sample)} != {sorted(actual)}")
        for k in set(sample) & set(actual):
            if k in FREE_DICTS:
                continue
            out += conforms(sample[k], actual[k], f"{path}.{k}")
        return out
    if isinstance(sample, list) and isinstance(actual, list):
        if sample and not actual:
            return [f"{path}: real list is empty, cannot compare"]
        return conforms(sample[0], actual[0], f"{path}[0]") if sample else []
    if type(sample) is not type(actual):
        return [f"{path}: {type(sample).__name__} != {type(actual).__name__}"]
    return []


def seed(api):
    ts = int(START.timestamp()) - 60
    tg = miniapp(api, make_init_data(auth_date=ts, start_param="s_spring")).json()
    sess = web_session(api, utm={"utm_source": "ig", "utm_campaign": "autumn"})
    offer = {"offer_id": "a1b2c3d4e5f1", "chain": "lidl", "category": "dairy"}
    events = [
        event("catalog_loaded", {"offers": 10, "from_cache": False}),
        event("offer_view", offer), event("offer_view", offer),
        event("cart_add", offer),
        event("search", {"len": 5, "results": 0, "query": "kinoa"}),
        event("share_link_created", {"lines": 2, "telegram": True}),
        event("cart_import", {"mode": "created", "added": 2, "missing": 0}),
        event("app_error", {"name": "TypeError", "where": "boundary"}),
    ]
    assert send(api, sess, events).status_code == 200
    return tg, sess


def check(name: str, actual) -> None:
    diffs = conforms(fixture(name), actual)
    assert not diffs, f"{name}: " + "; ".join(diffs)


def test_session_response_shape(api):
    r = api.post("/api/v1/analytics/session", json={
        "session_id": "33333333-3333-4333-8333-333333333333", "anon_id": "44444444-4444-4444-8444-444444444444",
        "platform": "web", "lang": "bg", "utm": {}})
    assert r.status_code == 200
    check("session.json", r.json())
    assert set(r.json()) == {"token", "visitor_id"}


def test_events_response_shape(api):
    sess = web_session(api)
    body = send(api, sess, [event()]).json()
    assert body == {"accepted": 1, "duplicates": 0, "rejected": []}


def test_admin_response_shapes(api):
    tg, web = seed(api)
    login(api)
    day = {"from": "2026-10-18", "to": "2026-10-18"}

    check("metrics.json", api.get("/api/admin/metrics", params=day).json())
    check("users.json", api.get("/api/admin/users", params=day).json())
    check("filters.json", api.get("/api/admin/filters").json())
    check("user_card_tg.json", api.get(f"/api/admin/users/{tg['visitor_id']}").json())
    check("user_card_anon.json", api.get(f"/api/admin/users/{web['visitor_id']}").json())


def test_admin_numbers_and_params(api):
    tg, web = seed(api)
    login(api)
    day = {"from": "2026-10-18", "to": "2026-10-18"}
    m = api.get("/api/admin/metrics", params=day).json()
    assert m["users"] == {"total": 2, "tg": 1, "anon": 1}
    assert (m["sessions"], m["miniapp_opens"], m["site_opens"], m["catalog_loads"]) == (2, 1, 1, 1)
    assert (m["cart_add_users"], m["share_links"], m["imports_successful"]) == (1, 1, 1)
    assert m["top_offers"]["viewed"][0] == {"offer_id": "a1b2c3d4e5f1", "chain": "lidl", "category": "dairy", "count": 2}
    assert m["zero_result_queries"] == [{"query": "kinoa", "count": 1}]
    assert m["errors"] == [{"name": "TypeError", "where": "boundary", "count": 1}]
    # filter params used by the frontend
    assert api.get("/api/admin/metrics", params={**day, "source_kind": "utm"}).json()["users"]["total"] == 1
    assert api.get("/api/admin/metrics", params={**day, "source": "telegram"}).json()["users"]["total"] == 1
    # pagination is limit/offset
    page = api.get("/api/admin/users", params={**day, "limit": 1, "offset": 1}).json()
    assert page["total"] == 2 and len(page["items"]) == 1 and page["offset"] == 1
    # users are listed under their own visitor_id
    ids = {i["visitor_id"] for i in api.get("/api/admin/users", params=day).json()["items"]}
    assert ids == {tg["visitor_id"], web["visitor_id"]}
