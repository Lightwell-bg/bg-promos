"""Strict whitelist validation of analytics events (docs/ANALYTICS.md, "Events").

Anything not in the table is rejected: unknown event names, unknown props keys, wrong types
(bool is never accepted as int and vice versa), out-of-range numbers, over-long strings.
Free text is never accepted except the normalised zero-result search ``query``.
"""

from __future__ import annotations

import re
import unicodedata
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta, timezone

CHAINS = ("lidl", "kaufland", "billa")
MAX_TS_SKEW = timedelta(days=2)
MAX_QUERY_LEN = 60

# Names that only the server may record (the client cannot inflate them through /events).
SERVER_ONLY = frozenset({"bot_start", "site_open", "miniapp_open"})

_ID_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,64}$")
_SLUG_RE = re.compile(r"^[a-z0-9_\-]{1,40}$")
_KEY_RE = re.compile(r"^[A-Za-z0-9_]{1,30}$")
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_WS_RE = re.compile(r"\s+")

AUTOMATED_UA_MARKERS = (
    "headlesschrome", "lighthouse", "pagespeed", "chrome-lighthouse", "bot", "crawler", "spider",
    "slurp", "telegrambot", "facebookexternalhit", "curl/", "wget", "python-requests", "python-httpx",
    "httpclient", "go-http-client", "okhttp", "node-fetch", "axios", "phantomjs", "puppeteer",
    "playwright", "selenium", "preview", "monitor", "uptime", "pingdom", "gtmetrix",
)


class EventError(ValueError):
    """The event does not match the whitelist (message never echoes user data)."""


def is_automated_ua(user_agent: str | None) -> bool:
    """True for headless browsers, Lighthouse, crawlers, link previews, scripts; empty UA too."""
    if not user_agent or not user_agent.strip():
        return True
    ua = user_agent.lower()
    return any(m in ua for m in AUTOMATED_UA_MARKERS)


def is_uuid(value: object) -> bool:
    if not isinstance(value, str) or len(value) != 36:
        return False
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def normalize_query(value: str) -> str:
    """lowercase, strip control chars, collapse whitespace, cut to 60 characters."""
    text = unicodedata.normalize("NFKC", value)
    text = _CTRL_RE.sub(" ", text).lower()
    return _WS_RE.sub(" ", text).strip()[:MAX_QUERY_LEN].strip()


def utc_iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---- primitive checkers -------------------------------------------------------------------

def _int(lo: int, hi: int) -> Callable[[object], int]:
    def check(v: object) -> int:
        if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
            raise EventError("bad int")
        return v
    return check


def _bool(v: object) -> bool:
    if not isinstance(v, bool):
        raise EventError("bad bool")
    return v


def _enum(*allowed: str) -> Callable[[object], str]:
    def check(v: object) -> str:
        if not isinstance(v, str) or v not in allowed:
            raise EventError("bad enum")
        return v
    return check


def _regex(rx: re.Pattern[str]) -> Callable[[object], str]:
    def check(v: object) -> str:
        if not isinstance(v, str) or not rx.match(v):
            raise EventError("bad string")
        return v
    return check


def _label(maxlen: int) -> Callable[[object], str]:
    """Short technical label (error name / location): control chars removed, 1..maxlen."""
    def check(v: object) -> str:
        if not isinstance(v, str):
            raise EventError("bad string")
        clean = _WS_RE.sub(" ", _CTRL_RE.sub(" ", v)).strip()
        if not clean or len(v) > maxlen * 4:
            raise EventError("bad string")
        return clean[:maxlen]
    return check


def _keys(v: object) -> list[str]:
    if not isinstance(v, list) or len(v) > 20:
        raise EventError("bad list")
    out = []
    for item in v:
        if not isinstance(item, str) or not _KEY_RE.match(item):
            raise EventError("bad list item")
        out.append(item)
    return out


_OFFER_PROPS = {
    "offer_id": _regex(_ID_RE),
    "chain": _enum(*CHAINS),
    "category": _regex(_SLUG_RE),
}

# name -> (required props, optional props)
_SCHEMAS: dict[str, tuple[dict[str, Callable], dict[str, Callable]]] = {
    "bot_start": ({"payload_kind": _enum("none", "label", "other")}, {}),
    "site_open": ({}, {}),
    "miniapp_open": ({}, {}),
    "catalog_loaded": ({"offers": _int(0, 1_000_000), "from_cache": _bool}, {}),
    "offer_view": (dict(_OFFER_PROPS), {}),
    "search": ({"len": _int(0, 1000), "results": _int(0, 1_000_000)}, {"query": None}),
    "filter_apply": ({"keys": _keys}, {}),
    "cart_add": (dict(_OFFER_PROPS), {}),
    "cart_remove": (dict(_OFFER_PROPS), {}),
    "cart_qty": ({"offer_id": _OFFER_PROPS["offer_id"], "chain": _OFFER_PROPS["chain"],
                  "delta": _int(-1_000_000, 1_000_000), "unit": _enum("piece", "g")}, {}),
    "card_toggle": ({"chain": _OFFER_PROPS["chain"], "on": _bool}, {}),
    "share_link_created": ({"lines": _int(0, 10_000), "telegram": _bool}, {}),
    "share_copy": ({"block": _enum("tg", "web"), "ok": _bool}, {}),
    "cart_import": ({"mode": _regex(re.compile(r"^[a-z_]{1,20}$")),
                     "added": _int(0, 10_000), "missing": _int(0, 10_000)}, {}),
    "app_error": ({"name": _label(60), "where": _label(60)}, {}),
}

EVENT_NAMES = frozenset(_SCHEMAS)


def validate_props(name: str, props: object) -> dict:
    """Return the cleaned props of event ``name`` or raise EventError."""
    if name not in _SCHEMAS:
        raise EventError("unknown event")
    if props is None:
        props = {}
    if not isinstance(props, dict):
        raise EventError("props must be an object")
    required, optional = _SCHEMAS[name]
    unknown = set(props) - set(required) - set(optional)
    if unknown:
        raise EventError("unknown props")
    out: dict = {}
    for key, check in required.items():
        if key not in props:
            raise EventError("missing props")
        out[key] = check(props[key])
    if name == "search":
        if "query" in props:
            q = props["query"]
            if out["results"] != 0:
                raise EventError("query only for zero results")
            if not isinstance(q, str) or len(q) > 1000:
                raise EventError("bad query")
            norm = normalize_query(q)
            if norm:
                out["query"] = norm
    return out


def validate_event(raw: object, now: datetime | None = None) -> dict:
    """Validate one client event ``{event_id, name, ts, props}``.

    Returns ``{event_id, name, ts (UTC 'YYYY-MM-DDTHH:MM:SSZ'), props}``.
    """
    if not isinstance(raw, dict):
        raise EventError("event must be an object")
    if set(raw) - {"event_id", "name", "ts", "props"}:
        raise EventError("unknown keys")
    event_id = raw.get("event_id")
    if not is_uuid(event_id):
        raise EventError("bad event_id")
    name = raw.get("name")
    if not isinstance(name, str):
        raise EventError("bad name")
    props = validate_props(name, raw.get("props"))
    ts_raw = raw.get("ts")
    if not isinstance(ts_raw, str) or len(ts_raw) > 40:
        raise EventError("bad ts")
    try:
        ts = datetime.fromisoformat(ts_raw)
    except ValueError as exc:
        raise EventError("bad ts") from exc
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    current = now or datetime.now(timezone.utc)
    if abs(ts - current) > MAX_TS_SKEW:
        raise EventError("ts out of range")
    return {"event_id": event_id.lower(), "name": name, "ts": utc_iso(ts), "props": props}
