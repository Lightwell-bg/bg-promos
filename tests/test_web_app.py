from __future__ import annotations

import dataclasses
import hashlib
import json
from datetime import datetime, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from bg_promos.web.app import accepts_gzip, create_app, etag_matches
from bg_promos.web.report import ReportService, client_ip, parse_networks

from conftest import make_offer, seed

NOW = datetime(2026, 10, 17, 12, 0, tzinfo=timezone.utc)
VALID = {"message": "Грешна цена на кашкавала", "offer_id": "abc123def456",
         "page_url": "https://promos.centerai.eu/", "lang": "bg", "hp": "", "elapsed_ms": 5000}


class Telegram:
    """MockTransport handler that records every request; ``fail`` selects the failure mode."""

    def __init__(self, fail: str | None = None) -> None:
        self.requests: list[httpx.Request] = []
        self.fail = fail

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.fail == "timeout":
            raise httpx.ReadTimeout("slow", request=request)
        if self.fail == "http":
            return httpx.Response(500, json={"ok": False})
        return httpx.Response(200, json={"ok": True})

    @property
    def calls(self) -> int:
        return len(self.requests)


class Clock:
    def __init__(self) -> None:
        self.t = 1_000_000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def seeded(web_settings):
    seed(web_settings, "lidl", [make_offer(key="1", name="Кашкавал")])
    return web_settings


def make_client(settings, telegram=None, clock=None, peer=("testclient", 50000), configured=True):
    if configured:
        settings = dataclasses.replace(settings, telegram_bot_token="123:abc", telegram_chat_id="-1001")
    tg = telegram or Telegram()
    clock = clock or Clock()
    service = ReportService(settings, transport=httpx.MockTransport(tg), clock=clock)
    app = create_app(settings, report_service=service, now_fn=lambda: NOW)
    return TestClient(app, client=peer), tg, clock


# ---- read endpoints -----------------------------------------------------------

def test_health_ok_and_db_down(seeded, tmp_path):
    client, _, _ = make_client(seeded)
    assert client.get("/api/health").json() == {"status": "ok", "db": True}
    broken = dataclasses.replace(seeded, data_dir=tmp_path / "missing")
    client, _, _ = make_client(broken)
    r = client.get("/api/health")
    assert r.status_code == 503 and r.json()["db"] is False
    assert client.get("/api/v1/catalog").status_code == 503


def test_catalog_etag_304_and_gzip(seeded):
    client, _, _ = make_client(seeded)
    r = client.get("/api/v1/catalog", headers={"Accept-Encoding": "identity"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/json; charset=utf-8"
    assert r.headers["cache-control"] == "no-cache"
    assert "accept-encoding" in r.headers["vary"].lower()
    assert "content-encoding" not in r.headers
    etag = r.headers["etag"]
    assert etag.startswith('"') and etag.endswith('"')
    body = r.json()
    assert [o["name"] for o in body["offers"]] == ["Кашкавал"] and body["today"] == "2026-10-17"

    not_modified = client.get("/api/v1/catalog", headers={"If-None-Match": etag})
    assert not_modified.status_code == 304 and not_modified.content == b""
    assert not_modified.headers["etag"] == etag
    assert client.get("/api/v1/catalog", headers={"If-None-Match": "W/" + etag}).status_code == 304
    assert client.get("/api/v1/catalog", headers={"If-None-Match": '"other"'}).status_code == 200

    gz = client.get("/api/v1/catalog", headers={"Accept-Encoding": "gzip"})
    assert gz.status_code == 200
    assert gz.headers["content-encoding"] == "gzip"
    assert gz.headers["etag"] == etag
    assert gz.json() == body  # httpx transparently decompresses


def test_catalog_picks_up_new_run(seeded):
    client, _, _ = make_client(seeded)
    first = client.get("/api/v1/catalog").headers["etag"]
    seed(seeded, "lidl", [make_offer(key="2", name="Сирене")])
    r = client.get("/api/v1/catalog", headers={"If-None-Match": first})
    assert r.status_code == 200 and r.headers["etag"] != first
    assert [o["name"] for o in r.json()["offers"]] == ["Сирене"]


def test_meta(seeded):
    client, _, _ = make_client(seeded)
    body = client.get("/api/v1/meta").json()
    assert set(body) == {"generated_at", "today", "chains"}
    assert body["today"] == "2026-10-17" and body["chains"]["lidl"]["status"] == "ok"
    assert body["chains"]["billa"]["status"] == "never"


def test_config(seeded):
    client, _, _ = make_client(seeded, configured=False)
    body = client.get("/api/v1/config").json()
    assert body["ga4_id"] is None and body["report_enabled"] is False
    assert body["contact_email"] == "info@centerai.eu" and body["operator"] == "CenterAI"
    assert body["brochures"] == {"lidl": "https://example.test/lidl-brochure"}
    assert body["telegram_bot"] is None
    configured, _, _ = make_client(dataclasses.replace(seeded, ga4_id="G-TEST123", bot_username="promoseubot"))
    body = configured.get("/api/v1/config").json()
    assert body["ga4_id"] == "G-TEST123" and body["report_enabled"] is True
    assert body["telegram_bot"] == "promoseubot"


def test_no_docs_ui(seeded):
    client, _, _ = make_client(seeded)
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404


def test_cors(seeded):
    client, _, _ = make_client(seeded)
    r = client.get("/api/v1/config", headers={"Origin": "capacitor://localhost"})
    assert r.headers["access-control-allow-origin"] == "capacitor://localhost"
    assert "access-control-allow-origin" not in client.get("/api/v1/config", headers={"Origin": "https://evil.test"}).headers
    cat = client.get("/api/v1/catalog", headers={"Origin": "https://promos.centerai.eu"})
    assert "etag" in cat.headers["access-control-expose-headers"].lower()
    pre = client.options("/api/v1/report", headers={
        "Origin": "https://localhost", "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
    })
    assert pre.status_code == 200 and pre.headers["access-control-allow-origin"] == "https://localhost"


def test_header_helpers():
    assert accepts_gzip("gzip, deflate, br") and accepts_gzip("GZIP;q=0.5")
    assert not accepts_gzip(None) and not accepts_gzip("identity") and not accepts_gzip("gzip;q=0")
    assert etag_matches('"a", "b"', '"b"') and etag_matches("*", '"b"') and not etag_matches(None, '"b"')


# ---- report -------------------------------------------------------------------

def test_report_not_configured(seeded):
    client, tg, _ = make_client(seeded, configured=False)
    r = client.post("/api/v1/report", json=VALID)
    assert r.status_code == 503 and r.json() == {"detail": "reporting not configured"}
    assert tg.calls == 0


def test_report_honeypot_and_too_fast_are_silently_dropped(seeded):
    client, tg, _ = make_client(seeded)
    for patch in ({"hp": "http://spam.test"}, {"elapsed_ms": 2999}, {"elapsed_ms": 0}):
        r = client.post("/api/v1/report", json={**VALID, **patch})
        assert r.status_code == 200 and r.json() == {"ok": True}
    assert tg.calls == 0
    # silently dropped requests must not consume the rate limit
    for _ in range(5):
        assert client.post("/api/v1/report", json=VALID).status_code == 200
    assert tg.calls == 5


def test_report_valid_sends_plain_text_once(seeded):
    client, tg, _ = make_client(seeded)
    r = client.post("/api/v1/report", json={**VALID, "message": "  <b>Грешка</b> & *цена*_  "})
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert tg.calls == 1
    req = tg.requests[0]
    assert str(req.url) == "https://api.telegram.org/bot123:abc/sendMessage"
    payload = json.loads(req.content)
    assert "parse_mode" not in payload
    assert payload["chat_id"] == "-1001" and payload["disable_web_page_preview"] is True
    ip_hash = hashlib.sha256(b"testclient").hexdigest()[:10]
    assert payload["text"] == (
        "BG Promos — съобщение за грешка\nЕзик: bg\nОферта: abc123def456\n"
        f"Страница: https://promos.centerai.eu/\nIP hash: {ip_hash}\n\n<b>Грешка</b> & *цена*_"
    )


@pytest.mark.parametrize("patch", [
    {"message": "кратко"[:4]},
    {"message": "x" * 1001},
    {"lang": "en"},
    {"page_url": "https://x.test/" + "a" * 300},
    {"offer_id": "bad id!"},
    {"elapsed_ms": "soon"},
])
def test_report_invalid_is_400(seeded, patch):
    client, tg, _ = make_client(seeded)
    assert client.post("/api/v1/report", json={**VALID, **patch}).status_code == 400
    assert tg.calls == 0


def test_report_missing_fields_and_bad_json_is_400(seeded):
    client, tg, _ = make_client(seeded)
    assert client.post("/api/v1/report", json={"message": "достатъчно дълго"}).status_code == 400
    assert client.post("/api/v1/report", content=b"not json",
                       headers={"Content-Type": "application/json"}).status_code == 400
    assert tg.calls == 0


def test_report_optional_fields_may_be_null(seeded):
    client, tg, _ = make_client(seeded)
    r = client.post("/api/v1/report", json={**VALID, "offer_id": None, "page_url": None})
    assert r.status_code == 200 and tg.calls == 1
    assert "Оферта: -\nСтраница: -\n" in json.loads(tg.requests[0].content)["text"]


def test_report_rate_limit_per_ip(seeded):
    client, tg, clock = make_client(seeded)
    for _ in range(5):
        assert client.post("/api/v1/report", json=VALID).status_code == 200
    assert client.post("/api/v1/report", json=VALID).status_code == 429
    assert tg.calls == 5
    clock.t += 3601  # hour window passed, daily budget (20) still has room
    assert client.post("/api/v1/report", json=VALID).status_code == 200
    assert tg.calls == 6


def test_report_daily_limits(seeded):
    settings = dataclasses.replace(seeded, report_hourly_per_ip=100, report_daily_per_ip=3, report_daily_global=4)
    client, tg, clock = make_client(settings)
    for _ in range(3):
        assert client.post("/api/v1/report", json=VALID).status_code == 200
        clock.t += 4000
    assert client.post("/api/v1/report", json=VALID).status_code == 429  # per-IP daily
    other = TestClient(client.app, client=("198.51.100.20", 1))
    assert other.post("/api/v1/report", json=VALID).status_code == 200  # global 4th
    third = TestClient(client.app, client=("198.51.100.21", 1))
    assert third.post("/api/v1/report", json=VALID).status_code == 429  # global daily
    clock.t += 86_400
    assert third.post("/api/v1/report", json=VALID).status_code == 200


def test_report_xff_honored_only_from_trusted_proxy(seeded):
    # direct peer is a trusted proxy: every XFF client has its own budget
    client, tg, _ = make_client(seeded, peer=("127.0.0.1", 1))
    for i in range(6):
        r = client.post("/api/v1/report", json=VALID, headers={"X-Forwarded-For": f"203.0.113.{i}, 10.0.0.1"})
        assert r.status_code == 200
    assert tg.calls == 6
    assert hashlib.sha256(b"203.0.113.0").hexdigest()[:10] in json.loads(tg.requests[0].content)["text"]
    # the same XFF client hits the limit
    for _ in range(4):
        client.post("/api/v1/report", json=VALID, headers={"X-Forwarded-For": "203.0.113.0"})
    assert client.post("/api/v1/report", json=VALID, headers={"X-Forwarded-For": "203.0.113.0"}).status_code == 429

    # untrusted direct peer: a spoofed header must not dodge the limit
    spoof, tg2, _ = make_client(seeded, peer=("198.51.100.7", 1))
    codes = [spoof.post("/api/v1/report", json=VALID, headers={"X-Forwarded-For": f"203.0.113.{i}"}).status_code
             for i in range(6)]
    assert codes == [200] * 5 + [429]
    assert hashlib.sha256(b"198.51.100.7").hexdigest()[:10] in json.loads(tg2.requests[0].content)["text"]


def test_client_ip_function():
    trusted = parse_networks(("127.0.0.1", "172.16.0.0/12"))
    assert client_ip("172.18.0.1", "203.0.113.9, 172.18.0.1", trusted) == "203.0.113.9"
    assert client_ip("127.0.0.1", "garbage", trusted) == "127.0.0.1"
    assert client_ip("127.0.0.1", None, trusted) == "127.0.0.1"
    assert client_ip("8.8.8.8", "203.0.113.9", trusted) == "8.8.8.8"
    assert client_ip(None, "203.0.113.9", trusted) == "unknown"


@pytest.mark.parametrize("mode", ["timeout", "http"])
def test_report_telegram_failure_is_503_and_not_retried(seeded, mode):
    client, tg, _ = make_client(seeded, telegram=Telegram(fail=mode))
    r = client.post("/api/v1/report", json=VALID)
    assert r.status_code == 503
    assert "123:abc" not in r.text
    assert tg.calls == 1  # no retry: a timeout means "maybe delivered"


# ---- review fixes -------------------------------------------------------------

def test_client_ip_walks_right_to_left():
    trusted = parse_networks(("127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
    # spoofed leftmost value, real client appended by the trusted proxy
    assert client_ip("172.18.0.2", "9.9.9.9, 203.0.113.5", trusted) == "203.0.113.5"
    assert client_ip("172.18.0.2", "9.9.9.9, 203.0.113.5, 10.1.1.1", trusted) == "203.0.113.5"
    assert client_ip("127.0.0.1", "10.0.0.5, 192.168.1.1", trusted) == "10.0.0.5"  # all trusted -> leftmost
    assert client_ip("203.0.113.77", "9.9.9.9", trusted) == "203.0.113.77"  # untrusted peer
    assert client_ip("::1", "2001:db8::1", trusted) == "2001:db8::1"


def test_trusted_proxies_default_and_empty_warning(seeded, caplog):
    from bg_promos.config import Settings
    assert "10.0.0.0/8" in Settings.__dataclass_fields__["trusted_proxies"].default
    assert "::1" in Settings.__dataclass_fields__["trusted_proxies"].default
    with caplog.at_level("WARNING"):
        ReportService(dataclasses.replace(seeded, trusted_proxies=()))
    assert "trusted_proxies is empty" in caplog.text


def test_etag_stable_across_hours_and_changes_with_stale_flag(web_settings):
    from datetime import timedelta
    from bg_promos.web.catalog import CatalogCache
    seed(web_settings, "lidl", [make_offer(key="1", name="One")])
    cache = CatalogCache(web_settings)
    first = cache.get(NOW)
    later = cache.get(NOW + timedelta(hours=1))  # new cache key, same content
    assert later is first and later[2] == first[2]
    assert json.loads(first[0])["generated_at"].startswith("2026-10-17T15:00")
    # much later the chain becomes stale: content differs -> new ETag
    stale = cache.get(NOW + timedelta(hours=100))
    assert stale[2] != first[2]
    assert json.loads(stale[0])["chains"]["lidl"]["stale"] is True


def test_cors_preflight_if_none_match_and_etag_exposed(seeded):
    client, _, _ = make_client(seeded)
    pre = client.options("/api/v1/catalog", headers={
        "Origin": "capacitor://localhost", "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "if-none-match, content-type",
    })
    assert pre.status_code == 200
    assert pre.headers["access-control-allow-origin"] == "capacitor://localhost"
    allowed = pre.headers["access-control-allow-headers"].lower()
    assert "if-none-match" in allowed and "content-type" in allowed
    r = client.get("/api/v1/catalog", headers={"Origin": "capacitor://localhost"})
    assert "etag" in r.headers["access-control-expose-headers"].lower()


@pytest.mark.parametrize("path", ["/api/health", "/api/v1/meta"])
def test_head_supported(seeded, path):
    client, _, _ = make_client(seeded)
    r = client.head(path)
    assert r.status_code == 200 and r.content == b""


def test_report_invalid_url_is_503_without_token_in_logs(seeded, caplog):
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.InvalidURL("bad url with 123:abc")
    settings = dataclasses.replace(seeded, telegram_bot_token="123:abc", telegram_chat_id="-1001")
    service = ReportService(settings, transport=httpx.MockTransport(boom), clock=Clock())
    client = TestClient(create_app(settings, report_service=service, now_fn=lambda: NOW))
    with caplog.at_level("ERROR"):
        r = client.post("/api/v1/report", json=VALID)
    assert r.status_code == 503 and "123:abc" not in r.text
    assert "InvalidURL" in caplog.text and "123:abc" not in caplog.text
