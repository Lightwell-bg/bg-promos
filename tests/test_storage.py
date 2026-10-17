from __future__ import annotations

from datetime import date

import pytest

from bg_promos.models import PriceCondition
from bg_promos.storage import Storage

from conftest import make_offer


@pytest.fixture
def storage():
    s = Storage(":memory:")
    yield s
    s.close()


def run(storage, offers, chain="lidl", status="ok"):
    rid = storage.start_run(chain)
    stats = storage.save_offers(rid, chain, offers)
    storage.finish_run(rid, status, len(offers))
    return rid, stats


def count(storage, table):
    return storage.conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


def test_first_save_creates_everything(storage):
    _, stats = run(storage, [make_offer(key="1"), make_offer(key="2")])
    assert stats == {"offers": 2, "new_offers": 2, "new_products": 2, "price_changes": 0}
    assert count(storage, "products") == 2
    assert count(storage, "offers") == 2
    assert count(storage, "price_observations") == 4  # regular + promo each


def test_second_identical_save_is_idempotent(storage):
    offers = [make_offer(key="1")]
    run(storage, offers)
    _, stats = run(storage, [make_offer(key="1")])
    assert stats["new_offers"] == 0 and stats["new_products"] == 0 and stats["price_changes"] == 0
    assert count(storage, "offers") == 1
    assert count(storage, "price_observations") == 2


def test_price_change_adds_observation(storage):
    run(storage, [make_offer(key="1")])
    changed = make_offer(key="1", prices=[PriceCondition("regular", 200), PriceCondition("promo", 120, discount_pct=40)])
    _, stats = run(storage, [changed])
    assert stats["price_changes"] == 1
    assert count(storage, "price_observations") == 3
    [offer] = storage.offers_of_last_success("lidl")
    promo = next(p for p in offer["prices"] if p["kind"] == "promo")
    assert promo["price_cents"] == 120


def test_same_product_in_two_validity_windows(storage):
    week1 = make_offer(key="P", valid_from=date(2026, 10, 12), valid_to=date(2026, 10, 18))
    week2 = make_offer(
        key="P", valid_from=date(2026, 10, 19), valid_to=date(2026, 10, 25),
        prices=[PriceCondition("promo", 100)],
    )
    run(storage, [week1])
    _, stats = run(storage, [week1, week2])
    assert stats["new_offers"] == 1 and stats["new_products"] == 0
    assert count(storage, "products") == 1
    assert count(storage, "offers") == 2
    product_id = storage.conn.execute("SELECT id FROM products").fetchone()[0]
    history = storage.price_history(product_id)
    assert len(history) == 3  # week1: regular + promo, week2: promo
    assert len({h["offer_id"] for h in history}) == 2


def test_offers_of_last_success_excludes_absent_offers(storage):
    run(storage, [make_offer(key="1"), make_offer(key="2")])
    run(storage, [make_offer(key="1")])
    assert [o["source_key"] for o in storage.offers_of_last_success("lidl")] == ["1"]
    assert count(storage, "offers") == 2  # the old one stays in the database


def test_offers_of_last_success_ignores_non_ok_runs(storage):
    run(storage, [make_offer(key="1")])
    rid = storage.start_run("lidl")
    storage.finish_run(rid, "suspicious", 0, None, "too few")
    assert [o["source_key"] for o in storage.offers_of_last_success("lidl")] == ["1"]
    assert storage.last_run("lidl")["status"] == "suspicious"
    assert storage.last_run("lidl", "ok")["status"] == "ok"


def test_offer_dict_shape(storage):
    run(storage, [make_offer(key="1", valid_from=None, valid_to=None)])
    [o] = storage.offers_of_last_success("lidl")
    assert o["valid_from"] is None and o["valid_to"] is None
    assert o["product_ref"] == "1"
    assert {p["kind"] for p in o["prices"]} == {"regular", "promo"}


def test_recent_ok_counts_and_wrong_chain(storage):
    run(storage, [make_offer(key="1")])
    run(storage, [make_offer(key="1"), make_offer(key="2")])
    assert storage.recent_ok_counts("lidl", 5) == [2, 1]
    with pytest.raises(ValueError):
        storage.save_offers(storage.start_run("lidl"), "lidl", [make_offer(chain="billa")])
