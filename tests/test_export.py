from __future__ import annotations

import json
import os
from datetime import date, datetime, timezone

import pytest

from bg_promos.export import export_all
from bg_promos.models import PriceCondition
from bg_promos.storage import Storage

from conftest import make_offer

# 2026-10-18T22:30Z is already Monday 2026-10-19 01:30 in Sofia (EEST, UTC+3)
NOW = datetime(2026, 10, 18, 22, 30, tzinfo=timezone.utc)


@pytest.fixture
def storage():
    s = Storage(":memory:")
    yield s
    s.close()


def save_run(storage, chain, offers, status="ok", finished="2026-10-18T21:00:00+00:00", error=None):
    rid = storage.start_run(chain)
    if status == "ok":
        storage.save_offers(rid, chain, offers)
    storage.finish_run(rid, status, len(offers), None, error)
    storage.conn.execute(
        "UPDATE scrape_runs SET started_at = ?, finished_at = ? WHERE id = ?", (finished, finished, rid)
    )
    storage.conn.commit()
    return rid


def read(settings, name):
    return json.loads((settings.data_dir / "export" / name).read_text(encoding="utf-8"))


def offers_set():
    return [
        make_offer(key="old", name="Old week", valid_from=date(2026, 10, 12), valid_to=date(2026, 10, 18)),
        make_offer(
            key="now", name="Current", valid_from=date(2026, 10, 19), valid_to=date(2026, 10, 25),
            prices=[
                PriceCondition("regular", 200),
                PriceCondition("promo", 150, discount_pct=25),
                PriceCondition("loyalty", 120, program="lidl_plus", discount_pct=40),
            ],
        ),
        make_offer(key="next", name="Upcoming", valid_from=date(2026, 10, 26), valid_to=date(2026, 11, 1)),
        make_offer(
            key="open", name="Open ended", valid_from=None, valid_to=None,
            prices=[PriceCondition("regular", 500), PriceCondition("loyalty", 400, program="lidl_plus")],
        ),
    ]


def test_current_upcoming_split_by_sofia_date(storage, settings):
    save_run(storage, "lidl", offers_set())
    export_all(storage, settings, NOW)

    current = read(settings, "offers_current.json")
    upcoming = read(settings, "offers_upcoming.json")
    assert [o["name"] for o in current["offers"]] == ["Current", "Open ended"]  # "Old week" expired in Sofia
    assert [o["name"] for o in upcoming["offers"]] == ["Upcoming"]
    assert [o["name"] for o in read(settings, "lidl.json")["offers"]] == ["Current", "Open ended", "Upcoming"]


def test_before_sofia_midnight_old_week_still_current(storage, settings):
    save_run(storage, "lidl", offers_set())
    export_all(storage, settings, datetime(2026, 10, 18, 20, 30, tzinfo=timezone.utc))  # 23:30 Sofia, still the 18th
    names = [o["name"] for o in read(settings, "offers_current.json")["offers"]]
    assert "Old week" in names and "Upcoming" not in names


def test_convenience_fields(storage, settings):
    save_run(storage, "lidl", offers_set())
    export_all(storage, settings, NOW)
    by_name = {o["name"]: o for o in read(settings, "offers_current.json")["offers"]}

    cur = by_name["Current"]
    assert cur["price_cents"] == 150
    assert cur["regular_price_cents"] == 200
    assert cur["discount_pct"] == 25
    assert cur["loyalty_price_cents"] == 120 and cur["loyalty_program"] == "lidl_plus"
    assert cur["chain"] == "lidl" and cur["valid_from"] == "2026-10-19"
    assert {p["kind"] for p in cur["prices"]} == {"regular", "promo", "loyalty"}

    open_ended = by_name["Open ended"]
    assert open_ended["price_cents"] is None  # headline price is the promo price only
    assert open_ended["best_price"]["kind"] == "loyalty" and open_ended["best_price"]["price_cents"] == 400
    assert open_ended["discount_pct"] is None
    assert open_ended["valid_from"] is None and open_ended["valid_to"] is None

    priceless = make_offer(key="np", name="No price", prices=[])
    save_run(storage, "kaufland", [make_offer(chain="kaufland", key="np", name="No price", prices=[],
                                              valid_from=None, valid_to=None)])
    export_all(storage, settings, NOW)
    [o] = read(settings, "kaufland.json")["offers"]
    assert o["price_cents"] is None and o["regular_price_cents"] is None and o["loyalty_price_cents"] is None
    assert o["best_price"] is None
    assert priceless.prices == []


def best(*prices):
    from bg_promos.export import public_offer

    row = {k: None for k in (
        "brand", "description", "category", "unit_text", "offer_label", "valid_from", "valid_to",
        "image_url", "product_url")}
    row.update(chain="lidl", product_ref="1", source_key="1", name="X")
    row["prices"] = [
        {"kind": p.kind, "program": p.program, "min_qty": p.min_qty, "price_cents": p.price_cents,
         "discount_pct": p.discount_pct, "condition_text": None}
        for p in prices
    ]
    return public_offer(row)


def test_best_price_loyalty_only():
    o = best(PriceCondition("regular", 500), PriceCondition("loyalty", 400, program="lidl_plus", discount_pct=20))
    assert o["price_cents"] is None and o["discount_pct"] is None
    assert o["best_price"] == {"kind": "loyalty", "program": "lidl_plus", "min_qty": 1,
                               "price_cents": 400, "unit_price_cents": 400, "discount_pct": 20}


def test_best_price_multibuy_only_is_per_unit():
    o = best(PriceCondition("regular", 300), PriceCondition("multibuy", 500, min_qty=2, discount_pct=17))
    assert o["best_price"] == {"kind": "multibuy", "program": None, "min_qty": 2,
                               "price_cents": 500, "unit_price_cents": 250, "discount_pct": 17}


def test_best_price_cheapest_of_promo_and_loyalty():
    o = best(PriceCondition("regular", 200), PriceCondition("promo", 150, discount_pct=25),
             PriceCondition("loyalty", 120, program="lidl_plus", discount_pct=40))
    assert o["price_cents"] == 150 and o["discount_pct"] == 25
    assert o["best_price"]["kind"] == "loyalty" and o["best_price"]["unit_price_cents"] == 120
    o = best(PriceCondition("promo", 100), PriceCondition("loyalty", 120, program="lidl_plus"))
    assert o["best_price"]["kind"] == "promo"


def test_best_price_regular_only():
    o = best(PriceCondition("regular", 199))
    assert o["price_cents"] is None and o["regular_price_cents"] == 199
    assert o["best_price"]["kind"] == "regular" and o["best_price"]["unit_price_cents"] == 199


@pytest.mark.skipif(os.name == "nt", reason="POSIX file modes only")
def test_exported_files_are_world_readable(storage, settings):
    save_run(storage, "lidl", [make_offer()])
    paths = export_all(storage, settings, NOW)
    assert paths["current"].stat().st_mode & 0o777 == 0o644


def test_meta(storage, settings):
    save_run(storage, "lidl", offers_set())
    export_all(storage, settings, NOW)
    meta = read(settings, "offers_current.json")["meta"]
    assert meta["generated_at"] == "2026-10-19T01:30:00+03:00"
    assert meta["currency"] == "EUR" and meta["timezone"] == "Europe/Sofia"
    assert meta["bgn_rate"] == 1.95583
    lidl = meta["chains"]["lidl"]
    assert lidl["status"] == "ok" and lidl["stale"] is False and lidl["stale_reason"] is None
    assert lidl["offers_current"] == 2 and lidl["offers_upcoming"] == 1
    assert lidl["valid_from_min"] == "2026-10-19" and lidl["valid_to_max"] == "2026-11-01"
    assert lidl["last_success_at"] == "2026-10-18T21:00:00+00:00"
    never = meta["chains"]["billa"]
    assert never["status"] == "never" and never["stale"] is True and "never succeeded" in never["stale_reason"]
    assert set(read(settings, "lidl.json")["meta"]["chains"]) == {"lidl"}


def test_stale_when_last_run_not_ok_keeps_previous_offers(storage, settings):
    save_run(storage, "lidl", offers_set())
    save_run(storage, "lidl", [], status="suspicious", finished="2026-10-18T21:30:00+00:00", error="only 0 offers")
    export_all(storage, settings, NOW)
    doc = read(settings, "offers_current.json")
    info = doc["meta"]["chains"]["lidl"]
    assert info["status"] == "suspicious" and info["stale"] is True
    assert "only 0 offers" in info["stale_reason"]
    assert len(doc["offers"]) == 2  # previous good data is still exported


def test_stale_when_success_is_too_old(storage, settings):
    save_run(storage, "lidl", offers_set(), finished="2026-10-17T09:00:00+00:00")  # 37.5 h before NOW
    export_all(storage, settings, NOW)
    info = read(settings, "offers_current.json")["meta"]["chains"]["lidl"]
    assert info["stale"] is True and "older than" in info["stale_reason"]

    save_run(storage, "lidl", offers_set(), finished="2026-10-17T11:00:00+00:00")  # 35.5 h
    export_all(storage, settings, NOW)
    assert read(settings, "offers_current.json")["meta"]["chains"]["lidl"]["stale"] is False


def test_disabled_chain_not_exported(storage, settings):
    settings.chains["billa"].enabled = False
    export_all(storage, settings, NOW)
    assert not (settings.data_dir / "export" / "billa.json").exists()
    assert "billa" not in read(settings, "offers_current.json")["meta"]["chains"]


def test_files_valid_utf8_atomic_and_deterministic(storage, settings):
    cyr = make_offer(key="c", name="Мляко прясно", valid_from=None, valid_to=None)
    save_run(storage, "lidl", [cyr, make_offer(key="a", name="Aaa", valid_from=None, valid_to=None)])
    paths = export_all(storage, settings, NOW)
    first = paths["current"].read_text(encoding="utf-8")
    assert "Мляко прясно" in first  # not \u-escaped
    assert [o["name"] for o in json.loads(first)["offers"]] == ["Aaa", "Мляко прясно"]
    export_all(storage, settings, NOW)
    assert paths["current"].read_text(encoding="utf-8") == first
    export_dir = settings.data_dir / "export"
    assert sorted(p.name for p in export_dir.iterdir()) == [
        "billa.json", "kaufland.json", "lidl.json", "offers_current.json", "offers_upcoming.json",
    ]
