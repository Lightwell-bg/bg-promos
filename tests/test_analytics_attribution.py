from __future__ import annotations

from bg_promos.analytics.attribution import (
    LEGACY_SHARE, UNKNOWN, Source, from_referrer, from_utm, parse_label, resolve_site_source, split_start_param,
)

OWN = ("promos.centerai.eu",)


def test_utm_sanitised():
    s = from_utm({"utm_source": " Facebook<script> ", "utm_medium": "CPC", "utm_campaign": "Spring 2026!",
                  "utm_content": "Story_1"})
    assert s == Source("utm", "facebookscript", "cpc", "spring2026", "story_1")
    assert from_utm({"utm_source": 5, "utm_campaign": ["x"]}) is None
    assert from_utm({}) is None
    assert len(from_utm({"utm_source": "a" * 500}).source) == 64


def test_referrer():
    assert from_referrer("https://www.google.com/search?q=x", OWN) == Source("referrer", "google.com")
    assert from_referrer("https://promos.centerai.eu/bg/", OWN) is None
    assert from_referrer("https://sub.promos.centerai.eu/", OWN) is None
    assert from_referrer("https://t.me/somechannel", OWN) is None
    assert from_referrer("https://web.telegram.org/k/", OWN) is None
    assert from_referrer("", OWN) is None and from_referrer(None, OWN) is None
    assert from_referrer("not a url", OWN) is None


def test_site_source_priority():
    assert resolve_site_source({"utm_source": "ig"}, "https://google.com/", OWN).kind == "utm"
    assert resolve_site_source({}, "https://google.com/", OWN).kind == "referrer"
    assert resolve_site_source({}, "https://promos.centerai.eu/", OWN) == UNKNOWN


def test_labels():
    assert parse_label("s_spring-ig_story", "startapp") == Source(
        "startapp", "telegram", "miniapp", "spring", "ig_story")
    assert parse_label("S_Spring", "start") == Source("start", "telegram", "bot", "spring", None)
    for bad in ("", None, "x_spring", "s_", "s_a b", "s_" + "a" * 33, "c1_abc", "s_a-b-c"):
        assert parse_label(bad, "start") == UNKNOWN


def test_split_start_param():
    assert split_start_param("s_spring-ig__c1_abc") == ("s_spring-ig", "c1_abc")
    assert split_start_param("c1_abc") == (None, "c1_abc")
    assert split_start_param("s_spring") == ("s_spring", None)
    assert split_start_param(None) == (None, None)
    # a cart-only param never yields a source
    assert parse_label(split_start_param("c1_abc")[0], "startapp") == UNKNOWN
    assert split_start_param("garbage") == (None, None)


def test_share_label_with_cart():
    label, cart = split_start_param("s_share-tg__c1_abc-2_def")
    assert (label, cart) == ("s_share-tg", "c1_abc-2_def")
    assert parse_label(label, "startapp") == Source("startapp", "telegram", "miniapp", "share", "tg")


def test_legacy_share_source_constant():
    assert LEGACY_SHARE == Source("startapp", "telegram", "miniapp", "share", "legacy")
