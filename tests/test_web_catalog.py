from __future__ import annotations

import gzip
import hashlib
import json
import threading
from datetime import date, datetime, timezone

import pytest

from bg_promos.models import PriceCondition
from bg_promos.storage import Storage
from bg_promos.web.catalog import CatalogCache, build_catalog, offer_id
from bg_promos.web.db import open_ro

from conftest import make_offer, seed

NOW = datetime(2026, 10, 17, 12, 0, tzinfo=timezone.utc)  # 2026-10-17 15:00 Sofia


def test_expired_dropped_upcoming_kept(web_settings):
    seed(web_settings, "lidl", [
        make_offer(key="expired", name="Expired", valid_from=date(2026, 10, 5), valid_to=date(2026, 10, 16)),
        make_offer(key="current", name="Current", valid_to=date(2026, 10, 17)),
        make_offer(key="upcoming", name="Upcoming", valid_from=date(2026, 10, 20), valid_to=date(2026, 10, 26)),
        make_offer(key="open", name="Open ended", valid_from=None, valid_to=None),
    ])
    cat = build_catalog(web_settings, NOW)
    names = {o["name"] for o in cat["offers"]}
    assert names == {"Current", "Upcoming", "Open ended"}
    assert cat["today"] == "2026-10-17"
    assert cat["currency"] == "EUR" and cat["version"] == 1
    assert cat["generated_at"].endswith("+03:00")


def test_ids_stable_and_formula(web_settings):
    seed(web_settings, "lidl", [make_offer(key="k1", name="A"), make_offer(key="k2", name="B")])
    first = build_catalog(web_settings, NOW)["offers"]
    second = build_catalog(web_settings, NOW)["offers"]
    assert [o["id"] for o in first] == [o["id"] for o in second]
    expected = hashlib.sha1(b"lidl|k1|2026-10-12|2026-10-18").hexdigest()[:12]
    assert first[0]["id"] == expected == offer_id("lidl", "k1", "2026-10-12", "2026-10-18")
    assert offer_id("lidl", "k", None, None) == hashlib.sha1(b"lidl|k||").hexdigest()[:12]


def test_offer_shape_categories_and_sorting(web_settings):
    seed(web_settings, "kaufland", [make_offer(chain="kaufland", key="z", name="Зелен сирене", product_ref="p-z")])
    seed(web_settings, "billa", [make_offer(chain="billa", key="a", name="Пилешко филе")])
    seed(web_settings, "lidl", [make_offer(key="m", name="Кашкавал")])
    cat = build_catalog(web_settings, NOW)
    assert [c["id"] for c in cat["categories"]][0] == "produce"
    assert {"id", "bg", "ru", "icon"} == set(cat["categories"][0])
    ids = {c["id"] for c in cat["categories"]}
    assert all(o["category"] in ids for o in cat["offers"])
    assert [o["chain"] for o in cat["offers"]] == ["billa", "kaufland", "lidl"]
    o = next(o for o in cat["offers"] if o["chain"] == "kaufland")
    for field in ("id", "chain", "product_ref", "name", "brand", "description", "category", "chain_category",
                  "unit_text", "label", "image_url", "source_url", "source_is_product", "valid_from", "valid_to",
                  "first_seen_at", "prices", "best", "no_card", "regular_cents", "savings_per_item_cents",
                  "unit_price"):
        assert field in o
    assert o["product_ref"] == "p-z"
    assert o["best"]["kind"] == "promo" and o["best"]["per_item_cents"] == 150
    assert o["regular_cents"] == 200 and o["savings_per_item_cents"] == 50
    assert {p["kind"] for p in o["prices"]} == {"regular", "promo"}
    assert all({"kind", "program", "min_qty", "total_cents", "per_item_cents", "discount_pct", "text"} == set(p)
               for p in o["prices"])
    assert set(cat["chains"]) == {"lidl", "kaufland", "billa"}
    assert cat["chains"]["lidl"]["name"] == "Lidl" and cat["chains"]["billa"]["name"] == "BILLA"
    assert cat["chains"]["lidl"]["brochure_url"] == "https://example.test/lidl-brochure"
    assert cat["chains"]["kaufland"]["brochure_url"] is None
    assert cat["chains"]["lidl"]["offers_url"] == "https://example.test/lidl/"


def test_source_url_fallback(web_settings):
    with_product = make_offer(key="1", name="One")
    with_product.product_url = "https://example.test/p/1"
    seed(web_settings, "lidl", [with_product, make_offer(key="2", name="Two")])
    by_name = {o["name"]: o for o in build_catalog(web_settings, NOW)["offers"]}
    assert (by_name["One"]["source_url"], by_name["One"]["source_is_product"]) == ("https://example.test/p/1", True)
    assert (by_name["Two"]["source_url"], by_name["Two"]["source_is_product"]) == ("https://example.test/lidl/", False)


def test_description_used_for_generic_names_only(web_settings):
    generic = make_offer(chain="billa", key="1", name="на 100 г")
    generic.description = "Сьомга филе"
    named = make_offer(chain="billa", key="2", name="Нещо неясно")
    named.description = "Сьомга филе"
    seed(web_settings, "billa", [generic, named])
    by_name = {o["name"]: o for o in build_catalog(web_settings, NOW)["offers"]}
    assert by_name["на 100 г"]["category"] == "meat_fish"
    assert by_name["Нещо неясно"]["category"] == "other"
    assert by_name["Нещо неясно"]["description"] == "Сьомга филе"  # shown to the user, only not used for matching


def test_multibuy_not_treated_as_single_price(web_settings):
    seed(web_settings, "billa", [make_offer(chain="billa", key="1", name="Йогурт", prices=[
        PriceCondition("regular", 199), PriceCondition("multibuy", 199, min_qty=2, condition_text="1+1")])])
    [o] = build_catalog(web_settings, NOW)["offers"]
    assert (o["best"]["total_cents"], o["best"]["min_qty"], o["best"]["per_item_cents"]) == (199, 2, 100)


def test_only_last_ok_run_is_published(web_settings):
    seed(web_settings, "lidl", [make_offer(key="old", name="Old")])
    seed(web_settings, "lidl", [make_offer(key="new", name="New")])
    seed(web_settings, "lidl", [make_offer(key="bad", name="Suspicious")], status="suspicious")
    cat = build_catalog(web_settings, NOW)
    assert [o["name"] for o in cat["offers"]] == ["New"]
    assert cat["chains"]["lidl"]["status"] == "suspicious" and cat["chains"]["lidl"]["stale"] is True


def test_read_only_connection_cannot_write(web_settings):
    seed(web_settings, "lidl", [make_offer()])
    conn = open_ro(web_settings.db_path)
    try:
        with pytest.raises(Exception, match="readonly"):
            conn.execute("DELETE FROM offers")
    finally:
        conn.close()
    with Storage.read_only(web_settings.db_path) as st:
        assert st.conn.execute("SELECT COUNT(*) FROM offers").fetchone()[0] == 1


def test_cache_rebuilds_only_when_key_changes(web_settings):
    seed(web_settings, "lidl", [make_offer(key="1", name="One")])
    cache = CatalogCache(web_settings)
    a = cache.get(NOW)
    assert cache.get(NOW) is a  # same tuple object: no rebuild
    later = datetime(2026, 10, 17, 12, 59, tzinfo=timezone.utc)
    assert cache.get(later) is a  # same UTC hour: no rebuild
    next_hour = datetime(2026, 10, 17, 13, 0, tzinfo=timezone.utc)
    c = cache.get(next_hour)
    assert cache._key[2] == "2026-10-17T13"  # new UTC hour rebuilds (stale flags refresh) ...
    assert c is a  # ... but identical content keeps the same bytes/ETag
    assert cache.get(next_hour) is c
    a = c
    assert a[2].startswith('"') and a[2].endswith('"') and len(a[2]) == 22
    assert gzip.decompress(a[1]) == a[0]
    assert json.loads(a[0])["offers"][0]["name"] == "One"

    seed(web_settings, "lidl", [make_offer(key="2", name="Two")])
    b = cache.get(NOW)
    assert b is not a and b[2] != a[2]
    assert [o["name"] for o in json.loads(b[0])["offers"]] == ["Two"]


def test_cache_rebuilds_on_sofia_midnight(web_settings):
    seed(web_settings, "lidl", [make_offer(key="1", name="Ends 18th", valid_to=date(2026, 10, 18))])
    cache = CatalogCache(web_settings)
    before = datetime(2026, 10, 18, 20, 59, tzinfo=timezone.utc)  # 23:59 Sofia (EEST)
    after = datetime(2026, 10, 18, 21, 1, tzinfo=timezone.utc)  # 00:01 on the 19th
    a = cache.get(before)
    assert json.loads(a[0])["today"] == "2026-10-18" and len(json.loads(a[0])["offers"]) == 1
    assert cache.get(before) is a
    b = cache.get(after)
    assert b is not a
    assert json.loads(b[0])["today"] == "2026-10-19" and json.loads(b[0])["offers"] == []


def test_etag_stable_for_identical_content(web_settings):
    seed(web_settings, "lidl", [make_offer(key="1", name="One")])
    one, two = CatalogCache(web_settings), CatalogCache(web_settings)
    assert one.get(NOW)[2] == two.get(NOW)[2]


def test_failed_run_after_ok_updates_chain_status(web_settings):
    seed(web_settings, "lidl", [make_offer(key="1", name="One")])
    cache = CatalogCache(web_settings)
    first = cache.get(NOW)
    seed(web_settings, "lidl", [], status="failed")
    second = cache.get(NOW)
    assert second is not first
    block = json.loads(second[0])["chains"]["lidl"]
    assert block["status"] == "failed" and block["stale"] is True
    assert len(json.loads(second[0])["offers"]) == 1  # last ok data stays published


def test_reader_does_not_lock_against_wal_writer(web_settings):
    seed(web_settings, "lidl", [make_offer(key="seed", name="run-1")])
    errors: list[BaseException] = []
    done = threading.Event()
    runs = 12

    def writer() -> None:
        try:
            with Storage(web_settings.db_path) as st:
                for i in range(runs):
                    run_id = st.start_run("lidl")
                    st.save_offers(run_id, "lidl", [
                        make_offer(key=f"r{i}-{n}", name=f"run{i}") for n in range(150)
                    ])
                    st.finish_run(run_id, "ok", offers_count=150)
        except BaseException as exc:  # noqa: BLE001 - reported by the main thread
            errors.append(exc)
        finally:
            done.set()

    cache = CatalogCache(web_settings)
    thread = threading.Thread(target=writer)
    thread.start()
    reads = 0
    while not done.is_set():
        try:
            cache.get(NOW)
            reads += 1
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)
            break
    thread.join(timeout=60)
    assert not errors, errors
    assert reads > 0
    final = json.loads(cache.get(NOW)[0])
    assert len(final["offers"]) == 150
    assert {o["name"] for o in final["offers"]} == {f"run{runs - 1}"}
