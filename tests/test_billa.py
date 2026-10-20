from __future__ import annotations

from datetime import date

import pytest

from bg_promos.sources.base import SourceFormatError
from bg_promos.sources.billa import parse_brochure

from conftest import FIXTURES

WEEK = (FIXTURES / "billa_week.html").read_text(encoding="utf-8")
EMPTY = (FIXTURES / "billa_upcoming_empty.html").read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def offers():
    return parse_brochure(WEEK, "https://ssbbilla.site/catalog/sedmichna-broshura")


def find(offers, text):
    matches = [o for o in offers if text in o.name]
    assert len(matches) == 1, f"{text!r}: {len(matches)} matches"
    return matches[0]


def cond(offer, kind, program=None):
    for p in offer.prices:
        if p.kind == kind and (program is None or p.program == program):
            return p
    raise AssertionError(f"{kind} not in {offer.prices}")


def test_count_and_validity(offers):
    assert len(offers) == 14
    normal = [o for o in offers if "Слънчогледово" not in o.name]
    assert all((o.valid_from, o.valid_to) == (date(2026, 10, 15), date(2026, 10, 21)) for o in normal)


def test_regular_and_promo(offers):
    o = find(offers, "Кашу печено")
    assert cond(o, "regular").price_cents == 1789
    promo = cond(o, "promo")
    assert (promo.price_cents, promo.discount_pct) == (1279, 28)


def test_multibuy_one_plus_one(offers):
    o = find(offers, "Luengo")
    assert cond(o, "regular").price_cents == 199
    m = cond(o, "multibuy")
    assert (m.price_cents, m.min_qty) == (199, 2)


def test_multibuy_four_items(offers):
    o = find(offers, "Milka Шоколад")
    m = cond(o, "multibuy")
    assert (m.price_cents, m.min_qty, m.discount_pct) == (400, 4, 49)


def test_loyalty_card_price(offers):
    o = find(offers, "Lenor")
    assert cond(o, "regular").price_cents == 971
    loyalty = cond(o, "loyalty")
    assert (loyalty.price_cents, loyalty.program) == (739, "billa_card")


def test_cashback_text_in_promo_condition(offers):
    cashback = [o for o in offers if o.offer_label and "Кешбек оферта" in o.offer_label]
    assert cashback
    for o in cashback:
        assert "Кешбек" in cond(o, "promo").condition_text


def test_item_period_and_limit(offers):
    o = find(offers, "Clever Слънчогледово олио")
    assert (o.valid_from, o.valid_to) == (date(2026, 10, 19), date(2026, 10, 21))
    assert "До 5 бр. на клиент на ден" in (o.description or "")


def test_header_and_marketing_rows_skipped(offers):
    assert all(o.prices for o in offers)
    assert not any(o.name.startswith("Валидност") for o in offers)


def test_empty_upcoming_page():
    assert parse_brochure(EMPTY, "u", required=False) == []
    with pytest.raises(SourceFormatError):
        parse_brochure(EMPTY, "u", required=True)


def _page(header: str | None, rows: list[str]) -> str:
    body = ""
    if header:
        body += f'<div class="product"><div class="actualProduct">{header}</div></div>'
    for r in rows:
        body += (
            '<div class="product"><div class="actualProduct">' + r + "</div>"
            '<div style="width: 22%"><span class="price">2,00</span></div>'
            '<div style="width: 21%"><span class="price">1,50</span></div></div>'
        )
    return f"<html><body>{body}</body></html>"


def test_validity_across_new_year():
    html = _page("Валидност: от понеделник 28.12. до неделя 03.01.2027 г.", ["Тестов продукт 1 кг"])
    [o] = parse_brochure(html)
    assert (o.valid_from, o.valid_to) == (date(2026, 12, 28), date(2027, 1, 3))


@pytest.mark.parametrize(
    "header, expected",
    [
        ("Валидност: от четвъртък 22,10, до сряда 28.10,2026 г.", (date(2026, 10, 22), date(2026, 10, 28))),
        ("Валидност: от четвъртък 22.10, до сряда 28,10,2026 г.", (date(2026, 10, 22), date(2026, 10, 28))),
        ("Валидност: от четвъртък 22.10. до сряда 28.10.2026 г.", (date(2026, 10, 22), date(2026, 10, 28))),
        ("Валидност: от сряда 30,12, до вторник 05,01,2027 г.", (date(2026, 12, 30), date(2027, 1, 5))),
    ],
)
def test_validity_header_separator_variants(header, expected):
    [o] = parse_brochure(_page(header, ["Тестов продукт 1 кг"]))
    assert (o.valid_from, o.valid_to) == expected


HEADER = "Валидност: от четвъртък 15.10. до сряда 21.10.2026 г."


def _multipack_page(*rows: str) -> str:
    body = f'<div class="product"><div class="actualProduct">{HEADER}</div></div>'
    for r in rows:
        body += f'<div class="product"><div class="actualProduct">{r}</div></div>'
    return f"<html><body>{body}</body></html>"


def test_card_row_and_plain_row_of_same_product_do_not_collapse():
    from bg_promos.sources.base import RawDocument
    from bg_promos.sources.billa import BillaSource

    html = _page(HEADER, ["Само с Billa Card - Тестов продукт 1 кг", "Тестов продукт 1 кг"])
    card, plain = parse_brochure(html)
    assert card.product_ref == plain.product_ref
    assert plain.source_key == plain.product_ref
    assert card.source_key == f"{card.product_ref}:billa_card"
    assert len(BillaSource().parse([RawDocument("b", "u", html.encode("utf-8"))])) == 2


def test_multipack_single_total_gets_discount_from_unit_price():
    html = _multipack_page(
        "Кинг оферти - Мултипак оферта за 3 бр. Тестов сок 1 л Цена за 1 бр. 1,99 € Цена за 3 бр. с отстъпка 3,00 €"
    )
    [o] = parse_brochure(html)
    m = cond(o, "multibuy")
    assert (m.price_cents, m.min_qty, m.discount_pct) == (300, 3, 50)  # 597 -> 300


def test_multipack_item_period_printed_after_prices_applies():
    html = _multipack_page(
        "Кинг оферти - Мултипак оферта 1+1 Тест Продукт 2 х 500 г Цена за 1 бр. 1,99 € "
        "Цена за 2 бр. без отстъпка 3,98 € Цена за 2 бр. с отстъпка 1,99 € от 19.10. до 21.10.2026 г."
    )
    [o] = parse_brochure(html)
    assert (o.valid_from, o.valid_to) == (date(2026, 10, 19), date(2026, 10, 21))
    assert "от 19" not in o.name and "до 21" not in o.name


def _fetch(handler, urls):
    import httpx

    from bg_promos.http import HttpClient
    from bg_promos.sources.billa import BillaSource

    with HttpClient("ua", delay_seconds=0, transport=httpx.MockTransport(handler), sleep=lambda s: None) as http:
        return BillaSource(urls).fetch(http)


def test_fetch_skips_failing_upcoming_document():
    import httpx

    def handler(request):
        if request.url.path == "/upcoming":
            return httpx.Response(404)
        return httpx.Response(200, text="<html></html>")

    docs = _fetch(handler, ["https://x.test/week", "https://x.test/upcoming"])
    assert [d.url for d in docs] == ["https://x.test/week"]


@pytest.mark.parametrize(
    "tag,program", [("Само с Billa Card", "billa_card"), ("Само с Billa App", "billa_app")]
)
def test_multipack_with_loyalty_program(tag, program):
    html = _multipack_page(
        f"{tag} - Мултипак оферта 1+1 Тест Продукт 500 г Цена за 1 бр. 1,99 € "
        "Цена за 2 бр. без отстъпка 3,98 € Цена за 2 бр. с отстъпка 1,99 €"
    )
    [o] = parse_brochure(html)
    m = cond(o, "multibuy")
    assert (m.program, m.min_qty, m.price_cents) == (program, 2, 199)
    assert o.source_key == f"{o.product_ref}:{program}"


def test_multipack_without_program_has_no_program():
    html = _multipack_page(
        "Кинг оферти - Мултипак оферта 1+1 Тест Продукт 500 г Цена за 1 бр. 1,99 € "
        "Цена за 2 бр. без отстъпка 3,98 € Цена за 2 бр. с отстъпка 1,99 €"
    )
    [o] = parse_brochure(html)
    assert cond(o, "multibuy").program is None


def test_fetch_second_url_server_error_or_timeout_fails_run():
    import httpx

    def server_error(request):
        return httpx.Response(500 if request.url.path == "/upcoming" else 200, text="<html></html>")

    with pytest.raises(httpx.HTTPStatusError):
        _fetch(server_error, ["https://x.test/week", "https://x.test/upcoming"])

    def timeout(request):
        if request.url.path == "/upcoming":
            raise httpx.ReadTimeout("slow", request=request)
        return httpx.Response(200, text="<html></html>")

    with pytest.raises(httpx.ReadTimeout):
        _fetch(timeout, ["https://x.test/week", "https://x.test/upcoming"])


def test_fetch_first_url_error_and_block_propagate():
    import httpx

    from bg_promos.http import HttpBlockedError

    with pytest.raises(httpx.HTTPStatusError):
        _fetch(lambda r: httpx.Response(404), ["https://x.test/week", "https://x.test/upcoming"])

    def blocked_second(request):
        return httpx.Response(403 if request.url.path == "/upcoming" else 200, text="<html></html>")

    with pytest.raises(HttpBlockedError):
        _fetch(blocked_second, ["https://x.test/week", "https://x.test/upcoming"])


def test_rows_without_header_is_format_error():
    with pytest.raises(SourceFormatError):
        parse_brochure(_page(None, ["Тестов продукт 1 кг"]))


def test_glued_unit_is_split_and_sold_by_piece():
    from bg_promos.web.units import sale_unit

    html = _page(
        HEADER, ["Fantasy Foods Панирани топени сиренца От деликатесната витрина За 1 кг1 бр."]
    )
    [o] = parse_brochure(html)
    assert "За 1 кг 1 бр." in o.name
    assert o.unit_text == "1 бр."
    assert sale_unit(o.unit_text) == "piece"
    from bg_promos.web.pricing import derive

    prices = [{"kind": p.kind, "program": p.program, "min_qty": p.min_qty, "price_cents": p.price_cents,
               "discount_pct": p.discount_pct, "condition_text": p.condition_text} for p in o.prices]
    assert derive(prices, o.unit_text, o.name)["unit_price"] is None
