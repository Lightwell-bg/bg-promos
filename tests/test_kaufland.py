from __future__ import annotations

import json
from datetime import date

import httpx
import pytest

from bg_promos.http import HttpClient
from bg_promos.sources.base import RawDocument, SourceFormatError
from bg_promos.sources.kaufland import KauflandSource

from conftest import fixture_doc

TODAY = date(2026, 10, 17)


@pytest.fixture
def source():
    return KauflandSource()


@pytest.fixture
def offers(source):
    return source.parse([fixture_doc("kaufland_oferti.html")], today=TODAY)


def by_prefix(offers, ident):
    matches = [o for o in offers if f".{ident}." in o.source_key]
    assert len(matches) == 1, ident
    return matches[0]


def kinds(offer):
    return {(p.kind, p.program): p for p in offer.prices}


def test_counts_and_dedupe(offers):
    ids = [o.source_key for o in offers]
    assert len(ids) == len(set(ids))
    # cycle 0: 5 + 4 offers minus one duplicate; cycle 1: 8 offers
    assert len(offers) == 16
    dup = by_prefix(offers, "20649551")
    first_category = dup.category
    assert first_category  # first category wins
    assert [o.category for o in offers if o.source_key == dup.source_key] == [first_category]


def test_reduced_price_offer(offers):
    o = by_prefix(offers, "09701331")
    assert o.chain == "kaufland"
    assert o.product_ref == "09701331"
    assert o.source_key.startswith("20261012000000.09701331.")
    assert o.name.endswith(": I")  # title + subtitle joined with a space
    assert o.unit_text == "125 г"
    assert o.offer_label == "reducedPrice"
    assert o.image_url.startswith("https://")
    assert (o.valid_from, o.valid_to) == (date(2026, 10, 12), date(2026, 10, 18))
    k = kinds(o)
    assert k[("regular", None)].price_cents == 299
    assert (k[("promo", None)].price_cents, k[("promo", None)].discount_pct) == (209, 30)
    assert ("loyalty", "kaufland_card") not in k


def test_name_joins_title_and_subtitle_without_newlines(offers):
    for o in offers:
        assert "\n" not in o.name and "  " not in o.name and o.name


def test_loyalty_offer_with_card(offers):
    o = by_prefix(offers, "01000431")
    k = kinds(o)
    assert k[("regular", None)].price_cents == 306
    assert (k[("promo", None)].price_cents, k[("promo", None)].discount_pct) == (199, 34)
    loyalty = k[("loyalty", "kaufland_card")]
    assert (loyalty.price_cents, loyalty.discount_pct) == (165, 46)


def test_multibuy_card_offer_from_fixture_uses_loyalty_fields(offers):
    o = by_prefix(offers, "00057181")
    assert [(p.kind, p.program, p.price_cents, p.min_qty) for p in o.prices] == [
        ("regular", None, 189, 1),
        ("multibuy", "kaufland_card", 189, 2),
    ]
    assert o.description and "ATANI" in o.description.upper()


def _doc(*items: dict) -> RawDocument:
    base = {"dateFrom": "2026-10-12", "dateTo": "2026-10-18", "klNr": "1", "label": "none"}
    offers = [{**base, "offerId": f"2026.{i}.BG", **it} for i, it in enumerate(items)]
    blob = {"props": {"offerData": {"cycles": [{"categories": [{"displayName": "C", "offers": offers}]}]}}}
    html = "<script>window.SSR['a'] = " + json.dumps(blob, ensure_ascii=False) + ";</script>"
    return RawDocument("o", "u", html.encode("utf-8"))


def _parse(*items: dict):
    return KauflandSource().parse([_doc(*items)], today=TODAY)


def test_multibuy_1plus1_with_card_via_loyalty_fields():
    (o,) = _parse({
        "title": "X", "detailTitle": "ВЗЕМИ 1+1 БЕЗПЛАТНО\nKAUFLAND CARD XTRA",
        "loyaltyFormattedPrice": "3,57 €", "loyaltyFormattedOldPrice": "7,14 €", "loyaltyDiscount": 50,
    })
    k = kinds(o)
    assert set(k) == {("regular", None), ("multibuy", "kaufland_card")}
    assert k[("regular", None)].price_cents == 357  # 7,14 / 2
    mb = k[("multibuy", "kaufland_card")]
    assert (mb.price_cents, mb.min_qty, mb.discount_pct) == (357, 2, 50)
    assert mb.condition_text == "ВЗЕМИ 1+1 БЕЗПЛАТНО KAUFLAND CARD XTRA"


def test_multibuy_1plus1_without_card_via_price():
    (o,) = _parse({
        "title": "X", "detailTitle": "ВЗЕМИ 1+1 БЕЗПЛАТНО", "price": 1.5, "discount": 50,
        "formattedPrice": "1,50 €", "formattedOldPrice": "3,00 €",
    })
    k = kinds(o)
    assert set(k) == {("regular", None), ("multibuy", None)}
    assert k[("regular", None)].price_cents == 150
    assert (k[("multibuy", None)].price_cents, k[("multibuy", None)].min_qty) == (150, 2)


def test_multibuy_2plus1_regular_is_old_over_three():
    (o,) = _parse({
        "title": "X", "detailTitle": "ВЗЕМИ 2+1 БЕЗПЛАТНО\nKAUFLAND CARD XTRA",
        "loyaltyFormattedPrice": "4,00 €", "loyaltyFormattedOldPrice": "6,00 €", "loyaltyDiscount": 33,
    })
    k = kinds(o)
    assert k[("regular", None)].price_cents == 200
    assert (k[("multibuy", "kaufland_card")].price_cents, k[("multibuy", "kaufland_card")].min_qty) == (400, 3)


def test_grams_like_500_plus_200_is_not_multibuy():
    (o,) = _parse({
        "title": "X", "detailTitle": "500+200 г БОНУС", "price": 3.0,
        "formattedPrice": "3,00 €", "formattedOldPrice": "4,00 €",
    })
    assert "multibuy" not in {p.kind for p in o.prices}


def test_brand_wide_card_discount_name_and_description():
    (o,) = _parse({
        "title": "", "subtitle": "", "klNr": "777",
        "detailTitle": "-20% отстъпка с\nKAUFLAND CARD XTRA",
        "detailDescription": "на\nвсички артикули\nмарка Хисар",
        "loyaltyFormattedPrice": "", "loyaltyDiscount": 20,
    })
    assert o.name == "на всички артикули марка Хисар"
    assert o.description == "-20% отстъпка с KAUFLAND CARD XTRA"
    assert not o.name.startswith("-")


def test_nameless_offer_falls_back_to_detail_title_then_placeholder():
    (a, b) = _parse(
        {"detailTitle": "Само\nзаглавие", "klNr": "5"},
        {"klNr": "6"},
    )
    assert a.name == "Само заглавие"
    assert b.name == "Артикул 6"


def test_offer_without_price_is_kept(offers):
    o = by_prefix(offers, "20932292")
    assert o.prices == []
    assert o.offer_label == "specialItems"


def test_empty_title_falls_back_to_subtitle(offers):
    o = by_prefix(offers, "09700072")
    assert o.name and not o.name.startswith(" ")


def test_offer_without_any_name_gets_placeholder(offers):
    o = by_prefix(offers, "20936759")
    assert o.name == "Артикул 20936759"
    assert o.price("promo").price_cents == 100
    assert o.description is None


def test_euro_price_quotation_offer(offers):
    o = by_prefix(offers, "09701111")
    k = kinds(o)
    assert (k[("regular", None)].price_cents, k[("promo", None)].price_cents) == (40, 35)


def test_both_cycles_kept_and_expired_dropped(source):
    doc = fixture_doc("kaufland_oferti.html")
    current = source.parse([doc], today=TODAY)
    assert {o.valid_to for o in current} == {date(2026, 10, 18), date(2026, 10, 25)}
    later = source.parse([doc], today=date(2026, 10, 19))  # first week is over
    assert later and {o.valid_to for o in later} == {date(2026, 10, 25)}
    assert len(later) == 8


def test_format_errors(source):
    with pytest.raises(SourceFormatError):
        source.parse([RawDocument("o", "u", b"<html><body>nothing</body></html>")])
    other = b"<script>window.SSR['a'] = {\"props\": {\"x\": 1}};</script>"
    with pytest.raises(SourceFormatError):
        source.parse([RawDocument("o", "u", other)])
    broken = b"<script>window.SSR['a'] = {not json};</script>"
    with pytest.raises(SourceFormatError):
        source.parse([RawDocument("o", "u", broken)])


def test_fetch_single_get():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, content=b"<html></html>", headers={"content-type": "text/html"})

    source = KauflandSource(url="https://www.kaufland.bg/x.html")
    with HttpClient("ua", delay_seconds=0, transport=httpx.MockTransport(handler), sleep=lambda s: None) as http:
        docs = source.fetch(http)
    assert calls == ["https://www.kaufland.bg/x.html"]
    assert len(docs) == 1 and docs[0].content == b"<html></html>"
