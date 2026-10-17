from __future__ import annotations

from bg_promos.web.pricing import derive


def p(kind, cents, qty=1, program=None, pct=None, text=None):
    return {"kind": kind, "program": program, "min_qty": qty, "price_cents": cents,
            "discount_pct": pct, "condition_text": text}


def test_promo_with_regular():
    d = derive([p("regular", 200), p("promo", 150, pct=25)], "500 г", "Сирене")
    assert d["best"]["kind"] == "promo"
    assert (d["best"]["total_cents"], d["best"]["per_item_cents"], d["best"]["min_qty"]) == (150, 150, 1)
    assert d["best"]["discount_pct"] == 25
    assert d["no_card"]["kind"] == "promo"
    assert d["regular_cents"] == 200
    assert d["savings_per_item_cents"] == 50
    assert d["unit_price"] == {"cents": 300, "per": "kg", "source": "computed"}


def test_loyalty_only_with_regular_gives_regular_as_no_card():
    d = derive([p("regular", 102), p("loyalty", 51, program="lidl_plus", pct=50)], None, "X")
    assert d["best"]["kind"] == "loyalty" and d["best"]["program"] == "lidl_plus"
    assert d["no_card"]["kind"] == "regular"
    assert d["no_card"]["total_cents"] == 102
    assert d["no_card"]["discount_pct"] is None
    assert d["savings_per_item_cents"] == 51


def test_loyalty_cheaper_than_promo():
    d = derive([p("regular", 200), p("promo", 150), p("loyalty", 120, program="kaufland_card")], None, "X")
    assert d["best"]["kind"] == "loyalty"
    assert d["no_card"]["kind"] == "promo" and d["no_card"]["total_cents"] == 150
    assert d["savings_per_item_cents"] == 80


def test_multibuy_two_for_price_is_per_item():
    d = derive([p("regular", 199), p("multibuy", 199, qty=2, text="1+1: 2 бр. за 1,99 €")], None, "X")
    b = d["best"]
    assert b["kind"] == "multibuy"
    assert (b["total_cents"], b["min_qty"], b["per_item_cents"]) == (199, 2, 100)  # 99.5 rounds to 100
    assert b["discount_pct"] == 50
    assert b["text"] == "1+1: 2 бр. за 1,99 €"
    assert d["savings_per_item_cents"] == 99  # regular 199 - best per item 100


def test_cheaper_promo_beats_multibuy_per_item():
    d = derive([p("regular", 200), p("promo", 80), p("multibuy", 200, qty=2)], None, "X")
    assert d["best"]["kind"] == "promo"
    assert d["best"]["per_item_cents"] == 80


def test_multibuy_beats_promo_when_cheaper_per_item():
    d = derive([p("regular", 200), p("promo", 150), p("multibuy", 200, qty=2)], None, "X")
    assert d["best"]["kind"] == "multibuy" and d["best"]["per_item_cents"] == 100
    assert d["no_card"]["kind"] == "multibuy"  # no loyalty program involved


def test_regular_only():
    d = derive([p("regular", 250)], None, "X")
    assert d["best"]["kind"] == "regular" and d["best"]["discount_pct"] is None
    assert d["no_card"] is None
    assert d["regular_cents"] == 250
    assert d["savings_per_item_cents"] is None


def test_no_prices():
    d = derive([], None, "X")
    assert d == {"best": None, "no_card": None, "regular_cents": None,
                 "savings_per_item_cents": None, "unit_price": None}


def test_unknown_regular_gives_no_savings():
    d = derive([p("promo", 150)], None, "X")
    assert d["best"]["kind"] == "promo"
    assert d["savings_per_item_cents"] is None
    assert d["regular_cents"] is None


def test_unit_price_uses_best_per_item_of_multibuy():
    d = derive([p("multibuy", 400, qty=2)], "500 г", "X")
    assert d["unit_price"]["cents"] == 400  # 200 per 500 g -> 4.00 per kg
