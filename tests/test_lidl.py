from __future__ import annotations

import json
from datetime import date

import httpx
import pytest

from bg_promos.http import HttpClient
from bg_promos.sources.base import RawDocument, SourceFormatError
from bg_promos.sources.lidl import LidlSource

from conftest import fixture_bytes, fixture_doc

TODAY = date(2026, 10, 17)


def by_id(offers):
    return {o.source_key: o for o in offers}


def kinds(offer):
    return {(p.kind, p.program): p for p in offer.prices}


@pytest.fixture
def source():
    return LidlSource()


@pytest.fixture
def offers(source):
    return source.parse([fixture_doc("lidl_page.json")], today=TODAY)


def test_only_promotional_items_kept(offers):
    raw = json.loads(fixture_bytes("lidl_page.json"))
    all_ids = [i["gridbox"]["data"]["productId"] for i in raw["items"]]
    assert len(all_ids) == 8
    assert len(offers) == 6  # 2 plain items dropped
    plain = [str(i["gridbox"]["data"]["productId"]) for i in raw["items"]
             if not i["gridbox"]["data"]["lidlPlus"] and not i["gridbox"]["data"]["price"].get("oldPrice")]
    assert len(plain) == 2
    assert not set(plain) & {o.source_key for o in offers}


def test_discounted_item_mapping(offers):
    o = by_id(offers)["10064410"]
    assert o.chain == "lidl"
    assert o.product_ref == "10064410"
    assert o.brand == "MILKA"
    assert o.name.startswith("MILKA ")
    assert o.category == "Светове на нуждата/Храна и близки до нея храни/Хляб и тестени изделия/Сладки закуски"
    assert o.unit_text.startswith("56 g/")
    assert o.image_url.startswith("https://")
    assert o.product_url == "https://www.lidl.bg/p/milka-donat/p10064410"
    assert o.description is None
    assert (o.valid_from, o.valid_to) == (date(2026, 10, 12), date(2026, 11, 8))
    k = kinds(o)
    assert k[("regular", None)].price_cents == 92
    assert (k[("promo", None)].price_cents, k[("promo", None)].discount_pct) == (78, 15)
    assert o.raw["productId"] == 10064410 and "storeEndDate" in o.raw


def test_description_is_plain_text(offers):
    o = by_id(offers)["10064409"]
    assert o.description and "<" not in o.description and "  " not in o.description


def test_dates_converted_to_sofia(offers):
    # storeStartDate 1791752400 = 2026-10-11T21:00Z = 2026-10-12 00:00 Sofia
    o = by_id(offers)["10064390"]
    assert o.valid_from == date(2026, 10, 12)
    assert o.valid_to == date(2026, 10, 18)


def test_lidl_plus_only_item(offers):
    o = by_id(offers)["10064390"]
    k = kinds(o)
    assert ("promo", None) not in k
    assert k[("regular", None)].price_cents == 102
    lp = k[("loyalty", "lidl_plus")]
    assert (lp.price_cents, lp.discount_pct) == (51, 50)
    assert o.unit_text.startswith("100 g/")


def test_no_regular_equal_to_promo(offers):
    for o in offers:
        reg = o.price("regular")
        promo = o.price("promo")
        if reg and promo:
            assert reg.price_cents > promo.price_cents


def test_expired_items_dropped(source):
    assert len(source.parse([fixture_doc("lidl_page.json")], today=date(2026, 10, 19))) == 3


def test_dedupe(source):
    doc = fixture_doc("lidl_page.json")
    assert len(source.parse([doc, doc], today=TODAY)) == 6


def test_format_errors(source):
    with pytest.raises(SourceFormatError):
        source.parse([RawDocument("p", "u", b'{"unexpected": 1}')])
    with pytest.raises(SourceFormatError):
        source.parse([RawDocument("p", "u", b"<html>not json</html>")])
    with pytest.raises(SourceFormatError):
        source.parse([RawDocument("p", "u", b'{"items": [1, 2], "numFound": 2}')])


def test_member_price_inside_price_object(source):
    page = {
        "numFound": 1,
        "items": [{"gridbox": {"data": {
            "productId": 5, "fullTitle": "X", "storeEndDate": 1792357199,
            "price": {"price": 1.0, "lidlPlus": [{"price": {"price": 0.8, "oldPrice": 1.0,
                                                           "discount": {"discountText": "20% по-ниско"}}}]},
        }}}],
    }
    [o] = source.parse([RawDocument("p", "u", json.dumps(page).encode())], today=TODAY)
    k = kinds(o)
    assert k[("regular", None)].price_cents == 100
    assert k[("loyalty", "lidl_plus")].price_cents == 80


def test_category_falls_back_to_coarse_value(source):
    def page(keyfacts):
        return {"numFound": 1, "items": [{"gridbox": {"data": {
            "productId": 6, "fullTitle": "X", "category": "Хранителни", "keyfacts": keyfacts,
            "storeEndDate": 1792357199, "price": {"price": 0.8, "oldPrice": 1.0},
        }}}]}

    [o] = source.parse([RawDocument("p", "u", json.dumps(page({}), ensure_ascii=False).encode())], today=TODAY)
    assert o.category == "Хранителни"
    [o] = source.parse(
        [RawDocument("p", "u", json.dumps(page({"wonCategoryPrimary": "A/B"}), ensure_ascii=False).encode())],
        today=TODAY,
    )
    assert o.category == "A/B"


def test_pagination():
    raw = json.loads(fixture_bytes("lidl_page.json"))
    items = raw["items"]
    seen_offsets = []

    def handler(request: httpx.Request) -> httpx.Response:
        q = request.url.params
        assert q["assortment"] == "BG" and q["locale"] == "bg_BG" and q["version"] == "v2.0.0"
        assert q["fetchsize"] == "4"
        offset = int(q["offset"])
        seen_offsets.append(offset)
        page = dict(raw, offset=offset, items=items[offset:offset + 4], numFound=8)
        return httpx.Response(200, json=page)

    source = LidlSource(page_size=4, max_pages=10)
    with HttpClient("ua", delay_seconds=0, transport=httpx.MockTransport(handler), sleep=lambda s: None) as http:
        docs = source.fetch(http)
    assert seen_offsets == [0, 4]
    assert [d.name for d in docs] == ["page-0000", "page-0001"]
    assert len(source.parse(docs, today=TODAY)) == 6


def test_max_pages_reached_before_numfound_is_format_error():
    raw = json.loads(fixture_bytes("lidl_page.json"))
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json=dict(raw, numFound=1000, items=raw["items"][:2]))

    source = LidlSource(page_size=2, max_pages=3)
    with HttpClient("ua", delay_seconds=0, transport=httpx.MockTransport(handler), sleep=lambda s: None) as http:
        with pytest.raises(SourceFormatError, match="truncated"):
            source.fetch(http)
    assert len(calls) == 3


def test_empty_page_before_numfound_is_format_error():
    raw = json.loads(fixture_bytes("lidl_page.json"))

    def handler(request: httpx.Request) -> httpx.Response:
        items = raw["items"][:2] if request.url.params["offset"] == "0" else []
        return httpx.Response(200, json=dict(raw, numFound=10, items=items))

    source = LidlSource(page_size=2, max_pages=10)
    with HttpClient("ua", delay_seconds=0, transport=httpx.MockTransport(handler), sleep=lambda s: None) as http:
        with pytest.raises(SourceFormatError, match="truncated"):
            source.fetch(http)
