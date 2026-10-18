from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from analytics_helpers import uid
from bg_promos.analytics.events import (
    EVENT_NAMES, EventError, is_automated_ua, normalize_query, validate_event, validate_props,
)

NOW = datetime(2026, 10, 18, 12, 0, tzinfo=timezone.utc)
OFFER = {"offer_id": "abc123def456", "chain": "lidl", "category": "dairy"}

VALID = {
    "bot_start": {"payload_kind": "label"},
    "site_open": {},
    "miniapp_open": {},
    "catalog_loaded": {"offers": 1500, "from_cache": False},
    "offer_view": OFFER,
    "search": {"len": 5, "results": 3},
    "filter_apply": {"keys": ["chain", "category"]},
    "cart_add": OFFER,
    "cart_remove": OFFER,
    "cart_qty": {"offer_id": "abc123def456", "chain": "billa", "delta": -250, "unit": "g"},
    "card_toggle": {"chain": "kaufland", "on": True},
    "share_link_created": {"lines": 4, "telegram": True},
    "share_copy": {"block": "tg", "ok": True},
    "cart_import": {"mode": "filled", "added": 3, "missing": 1},
    "app_error": {"name": "TypeError", "where": "OfferPage"},
}

INVALID = {
    "bot_start": {"payload_kind": "x"},
    "catalog_loaded": {"offers": True, "from_cache": False},
    "offer_view": {**OFFER, "chain": "tesco"},
    "search": {"len": -1, "results": 3},
    "filter_apply": {"keys": "chain"},
    "cart_add": {"offer_id": "a b", "chain": "lidl", "category": "dairy"},
    "cart_remove": {"offer_id": "x" * 65, "chain": "lidl", "category": "dairy"},
    "cart_qty": {"offer_id": "abc", "chain": "billa", "delta": 1.5, "unit": "g"},
    "card_toggle": {"chain": "lidl", "on": 1},
    "share_link_created": {"lines": 4},
    "share_copy": {"block": "email", "ok": True},
    "cart_import": {"mode": "Filled!", "added": 3, "missing": 1},
    "app_error": {"name": "", "where": "x"},
}


def ev(name: str, props: dict, **kw) -> dict:
    return {"event_id": uid(), "name": name, "ts": NOW.isoformat(), "props": props, **kw}


def test_whitelist_covers_docs():
    assert set(VALID) == EVENT_NAMES


@pytest.mark.parametrize("name", sorted(VALID))
def test_valid_events(name):
    out = validate_event(ev(name, VALID[name]), NOW)
    assert out["name"] == name and out["ts"] == "2026-10-18T12:00:00Z"
    assert out["props"] == VALID[name]


@pytest.mark.parametrize("name", sorted(INVALID))
def test_invalid_props(name):
    with pytest.raises(EventError):
        validate_event(ev(name, INVALID[name]), NOW)


@pytest.mark.parametrize("name", sorted(VALID))
def test_unknown_prop_key_rejected(name):
    with pytest.raises(EventError):
        validate_event(ev(name, {**VALID[name], "extra": 1}), NOW)


def test_missing_prop_rejected():
    with pytest.raises(EventError):
        validate_props("catalog_loaded", {"offers": 3})


def test_unknown_event_and_top_level_keys():
    with pytest.raises(EventError):
        validate_event(ev("purchase", {}), NOW)
    with pytest.raises(EventError):
        validate_event(ev("site_open", {}, user_id=5), NOW)
    with pytest.raises(EventError):
        validate_event("nope", NOW)


def test_event_id_and_ts():
    with pytest.raises(EventError):
        validate_event({**ev("site_open", {}), "event_id": "not-a-uuid"}, NOW)
    with pytest.raises(EventError):
        validate_event(ev("site_open", {}, ts="garbage"), NOW)
    with pytest.raises(EventError):
        validate_event(ev("site_open", {}, ts=(NOW + timedelta(days=3)).isoformat()), NOW)
    with pytest.raises(EventError):
        validate_event(ev("site_open", {}, ts=(NOW - timedelta(days=3)).isoformat()), NOW)
    ok = validate_event(ev("site_open", {}, ts=(NOW - timedelta(days=1, hours=23)).isoformat()), NOW)
    assert ok["ts"].endswith("Z")
    z = validate_event(ev("site_open", {}, ts="2026-10-18T14:00:00+02:00"), NOW)
    assert z["ts"] == "2026-10-18T12:00:00Z"


def test_app_error_details_are_clipped_not_rejected():
    out = validate_props("app_error", {
        "name": "RangeError", "where": "window", "message": "m" * 1000, "source": "external",
        "file": "https://cdn.example.com/" + "a" * 500, "line": None, "col": 7,
        "stack": ("line\n" * 1000) + "\x00", "path": "/" + "p" * 500,
    })
    assert len(out["message"]) == 300 and len(out["file"]) == 160 and len(out["path"]) == 160
    assert len(out["stack"]) == 1500 and "\n" in out["stack"] and "\x00" not in out["stack"]
    assert out["line"] is None and out["col"] == 7 and out["source"] == "external"


@pytest.mark.parametrize("bad", [
    {"source": "elsewhere"}, {"line": -1}, {"line": True}, {"line": "3"}, {"message": 5}, {"stack": ["x"]},
])
def test_app_error_bad_detail_types_rejected(bad):
    with pytest.raises(EventError):
        validate_props("app_error", {"name": "E", "where": "window", **bad})


def test_search_query_only_for_zero_results():
    with pytest.raises(EventError):
        validate_props("search", {"len": 4, "results": 2, "query": "milk"})
    out = validate_props("search", {"len": 8, "results": 0, "query": "  Мляко\t\x00  ПРЯСНО  "})
    assert out["query"] == "мляко прясно"
    assert "query" not in validate_props("search", {"len": 2, "results": 0, "query": " \x01 "})
    assert len(validate_props("search", {"len": 99, "results": 0, "query": "a" * 200})["query"]) == 60
    with pytest.raises(EventError):
        validate_props("search", {"len": 1, "results": 0, "query": 5})


def test_normalize_query():
    assert normalize_query("A\u0000B  C\n") == "a b c"


def test_automated_user_agents():
    for ua in ("Mozilla/5.0 HeadlessChrome/120", "Lighthouse", "Googlebot/2.1", "TelegramBot (like TwitterBot)",
               "facebookexternalhit/1.1", "curl/8.0", "python-requests/2.31", "Chrome-Lighthouse", "", None):
        assert is_automated_ua(ua), ua
    assert not is_automated_ua("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1")
    assert not is_automated_ua("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36")
