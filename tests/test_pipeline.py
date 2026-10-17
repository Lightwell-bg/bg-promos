from __future__ import annotations

import gzip
import json
import os
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from bg_promos.pipeline import (
    LOCK_NAME,
    LockBusyError,
    collect,
    collection_lock,
    is_due,
    purge_raw,
)
from bg_promos.sources.base import RawDocument
from bg_promos.storage import Storage

from conftest import make_offer

SOFIA = ZoneInfo("Europe/Sofia")
NOW = datetime(2026, 10, 17, 10, 0, tzinfo=timezone.utc)


class FakeSource:
    def __init__(self, chain, count=3, error=None):
        self.chain = chain
        self.count = count
        self.error = error
        self.fetch_calls = 0

    def fetch(self, http):
        self.fetch_calls += 1
        if self.error:
            raise self.error
        return [RawDocument("doc", "https://example.test/", f"{self.chain}-{self.count}".encode())]

    def parse(self, docs):
        return [make_offer(chain=self.chain, key=str(i), name=f"{self.chain} {i}") for i in range(self.count)]


CLOCK = {"now": NOW}


@pytest.fixture(autouse=True)
def frozen_storage_clock(monkeypatch):
    """Run timestamps written by Storage follow the ``now`` passed to collect()."""
    CLOCK["now"] = NOW
    monkeypatch.setattr("bg_promos.storage.utcnow", lambda: CLOCK["now"].isoformat(timespec="seconds"))


def run_collect(settings, sources, **kw):
    kw.setdefault("now", NOW)
    CLOCK["now"] = kw["now"]
    return collect(settings, sources={s.chain: s for s in sources}, **kw)


def runs(settings, chain):
    with Storage(settings.db_path) as st:
        return [dict(r) for r in st.conn.execute("SELECT * FROM scrape_runs WHERE chain = ? ORDER BY id", (chain,))]


def exported(settings, name="offers_current.json"):
    return json.loads((settings.data_dir / "export" / name).read_text(encoding="utf-8"))


# ---- completeness -------------------------------------------------------------------------


def test_ok_run_saves_and_exports(settings):
    assert run_collect(settings, [FakeSource("lidl", 3)]) == 0
    [r] = runs(settings, "lidl")
    assert (r["status"], r["offers_count"]) == ("ok", 3)
    assert len(r["content_hash"]) == 64
    doc = exported(settings)
    assert len(doc["offers"]) == 3
    assert doc["meta"]["chains"]["lidl"]["stale"] is False


def test_below_min_expected_is_suspicious_and_keeps_previous_offers(settings):
    assert run_collect(settings, [FakeSource("lidl", 3)]) == 0
    assert run_collect(settings, [FakeSource("lidl", 1)]) == 1
    last = runs(settings, "lidl")[-1]
    assert last["status"] == "suspicious"
    assert "only 1 offers" in last["error"]
    with Storage(settings.db_path) as st:
        assert len(st.offers_of_last_success("lidl")) == 3
        assert st.conn.execute("SELECT COUNT(*) FROM offers").fetchone()[0] == 3  # nothing new saved
    info = exported(settings)["meta"]["chains"]["lidl"]
    assert info["stale"] is True and "suspicious" in info["stale_reason"] and "only 1 offers" in info["stale_reason"]
    assert len(exported(settings)["offers"]) == 3


def test_ratio_against_median_of_recent_ok_runs(settings):
    settings.chains["lidl"].min_expected_offers = 1
    for _ in range(3):
        assert run_collect(settings, [FakeSource("lidl", 10)]) == 0
    assert run_collect(settings, [FakeSource("lidl", 5)]) == 1  # 5 < 0.6 * 10
    last = runs(settings, "lidl")[-1]
    assert last["status"] == "suspicious" and "median" in last["error"]
    assert run_collect(settings, [FakeSource("lidl", 6)]) == 0  # exactly 60 % is fine
    assert runs(settings, "lidl")[-1]["status"] == "ok"


def test_suspicious_run_records_offers_count(settings):
    assert run_collect(settings, [FakeSource("lidl", 1)]) == 1
    last = runs(settings, "lidl")[-1]
    assert (last["status"], last["offers_count"]) == ("suspicious", 1)


def test_suspicious_stays_suspicious_without_manual_accept(settings):
    settings.chains["lidl"].min_expected_offers = 1
    for _ in range(3):
        assert run_collect(settings, [FakeSource("lidl", 10)]) == 0
    for _ in range(4):  # repeated similar low counts are never auto-accepted
        assert run_collect(settings, [FakeSource("lidl", 5)]) == 1
    assert [r["status"] for r in runs(settings, "lidl")][-4:] == ["suspicious"] * 4
    with Storage(settings.db_path) as st:
        assert len(st.offers_of_last_success("lidl")) == 10
    assert collect(settings, sources={"lidl": FakeSource("lidl", 5)}, now=NOW, accept_suspicious=True) == 0
    assert runs(settings, "lidl")[-1]["status"] == "ok"
    settings.chains["kaufland"].min_expected_offers = 5
    for _ in range(3):
        assert run_collect(settings, [FakeSource("kaufland", 1)]) == 1
    assert runs(settings, "kaufland")[-1]["status"] == "suspicious"


def test_failure_after_offers_written_rolls_back_and_keeps_previous_snapshot(settings, monkeypatch):
    assert run_collect(settings, [FakeSource("lidl", 3)]) == 0
    with Storage(settings.db_path) as st:
        before = st.offers_of_last_success("lidl")
        products_before = st.conn.execute("SELECT COUNT(*) FROM products").fetchone()[0]

    original = Storage._finish_run_sql

    def boom(self, run_id, status, offers_count, content_hash, error):
        if status == "ok":  # offers are already written in the open transaction here
            raise RuntimeError("injected before commit")
        return original(self, run_id, status, offers_count, content_hash, error)

    monkeypatch.setattr(Storage, "_finish_run_sql", boom)
    assert run_collect(settings, [FakeSource("lidl", 4)]) == 1
    last = runs(settings, "lidl")[-1]
    assert last["status"] == "failed" and "injected" in last["error"]
    with Storage(settings.db_path) as st:
        assert st.offers_of_last_success("lidl") == before
        assert st.conn.execute("SELECT COUNT(*) FROM products").fetchone()[0] == products_before
        assert st.conn.execute("SELECT COUNT(*) FROM offers").fetchone()[0] == 3


def test_accept_suspicious_saves_offers(settings, caplog):
    settings.chains["lidl"].min_expected_offers = 50
    with caplog.at_level("WARNING"):
        assert collect(settings, sources={"lidl": FakeSource("lidl", 3)}, now=NOW, accept_suspicious=True) == 0
    assert "accept-suspicious" in caplog.text
    assert runs(settings, "lidl")[-1]["status"] == "ok"
    with Storage(settings.db_path) as st:
        assert len(st.offers_of_last_success("lidl")) == 3
    assert collect(settings, sources={"lidl": FakeSource("lidl", 0)}, now=NOW, accept_suspicious=True) == 1
    assert runs(settings, "lidl")[-1]["status"] == "suspicious"  # nothing found: never accepted


def test_cli_accept_suspicious_flag(monkeypatch):
    from bg_promos import cli

    seen = {}
    monkeypatch.setattr(cli, "collect", lambda settings, **kw: seen.update(kw) or 0)
    monkeypatch.setattr(cli.config, "load", lambda path=None: type("S", (), {"log_level": "INFO"})())
    assert cli.main(["collect", "--accept-suspicious"]) == 0
    assert seen["accept_suspicious"] is True


def test_failure_of_one_source_does_not_block_others(settings):
    boom = FakeSource("kaufland", error=RuntimeError("boom"))
    good_a, good_b = FakeSource("lidl"), FakeSource("billa")
    assert run_collect(settings, [good_a, boom, good_b]) == 1
    assert runs(settings, "lidl")[-1]["status"] == "ok"
    assert runs(settings, "billa")[-1]["status"] == "ok"
    failed = runs(settings, "kaufland")[-1]
    assert failed["status"] == "failed" and failed["error"] == "RuntimeError: boom"
    assert exported(settings)["meta"]["chains"]["kaufland"]["stale"] is True


def test_http_errors_are_recorded_as_failed(settings):
    import httpx

    from bg_promos.http import HttpBlockedError

    assert run_collect(settings, [FakeSource("lidl", error=HttpBlockedError("403 Forbidden"))]) == 1
    assert runs(settings, "lidl")[-1]["error"].startswith("HttpBlockedError:")
    assert run_collect(settings, [FakeSource("billa", error=httpx.ReadTimeout("slow"))]) == 1
    assert runs(settings, "billa")[-1]["error"].startswith("ReadTimeout:")


def test_unknown_or_disabled_chain_is_skipped(settings):
    assert run_collect(settings, [FakeSource("lidl")], chains=["billa"]) == 0


# ---- raw archive ----------------------------------------------------------------------------


def test_raw_documents_archived_and_old_ones_purged(settings):
    old_dir = settings.data_dir / "raw" / "lidl"
    old_dir.mkdir(parents=True)
    old = old_dir / "20260901T000000Z_doc.gz"
    old.write_bytes(gzip.compress(b"old"))
    recent = old_dir / "20261015T000000Z_doc.gz"
    recent.write_bytes(gzip.compress(b"recent"))
    run_collect(settings, [FakeSource("lidl", 3)])
    assert not old.exists() and recent.exists()
    new = old_dir / "20261017T100000Z_doc.gz"
    assert gzip.decompress(new.read_bytes()) == b"lidl-3"


def test_purge_raw_ignores_missing_dir(tmp_path):
    assert purge_raw(tmp_path / "nope", 14, NOW) == 0


# ---- lock -------------------------------------------------------------------------------------


def test_lock_prevents_concurrent_run(settings):
    settings.data_dir.mkdir(parents=True)
    source = FakeSource("lidl")
    with collection_lock(settings.data_dir / LOCK_NAME):
        assert run_collect(settings, [source]) == 2
    assert source.fetch_calls == 0


def test_second_acquisition_is_busy_and_released_lock_is_free(tmp_path):
    lock = tmp_path / LOCK_NAME
    with collection_lock(lock):
        with pytest.raises(LockBusyError), collection_lock(lock):
            pass
    with collection_lock(lock):  # acquirable again after release
        pass


def test_lock_released_even_when_run_crashes(tmp_path):
    lock = tmp_path / LOCK_NAME
    with pytest.raises(RuntimeError), collection_lock(lock):
        raise RuntimeError("crash")
    with collection_lock(lock):
        pass


def test_leftover_lock_file_of_dead_process_is_acquirable(settings):
    settings.data_dir.mkdir(parents=True)
    (settings.data_dir / LOCK_NAME).write_text("123 long ago")
    assert run_collect(settings, [FakeSource("lidl")]) == 0


# ---- schedule ---------------------------------------------------------------------------------


def add_run(storage, chain, started_utc: str, status="ok", error=None):
    rid = storage.start_run(chain, scheduled=True)
    storage.finish_run(rid, status, 1, error=error)
    storage.conn.execute("UPDATE scrape_runs SET started_at = ? WHERE id = ?", (started_utc, rid))
    storage.conn.commit()


def due(storage, now_iso, slots, chain="lidl"):
    return is_due(chain, storage, slots, SOFIA, datetime.fromisoformat(now_iso))


@pytest.fixture
def mem():
    s = Storage(":memory:")
    yield s
    s.close()


@pytest.fixture
def slots(settings):
    return settings.slots


def test_is_due_without_runs(mem, slots):
    assert due(mem, "2026-10-17T10:00:00+00:00", slots) is True


def test_is_due_normal_day(mem, slots):
    # 10:00Z = 13:00 Sofia (UTC+3), latest slot 12:30 local = 09:30Z
    add_run(mem, "lidl", "2026-10-17T09:00:00+00:00")
    assert due(mem, "2026-10-17T10:00:00+00:00", slots) is True  # last run belongs to the 06:30 slot
    add_run(mem, "lidl", "2026-10-17T09:40:00+00:00")
    assert due(mem, "2026-10-17T10:00:00+00:00", slots) is False
    assert due(mem, "2026-10-17T12:00:00+00:00", slots) is False  # 15:00 local, still the 12:30 slot
    assert due(mem, "2026-10-17T15:30:00+00:00", slots) is True  # 18:30 local slot reached


def test_is_due_other_chain_unaffected(mem, slots):
    add_run(mem, "lidl", "2026-10-17T09:40:00+00:00", status="ok")
    assert due(mem, "2026-10-17T10:00:00+00:00", slots, "lidl") is False
    assert due(mem, "2026-10-17T10:00:00+00:00", slots, "billa") is True


def test_is_due_failed_run_is_retried_next_hour(mem, slots):
    add_run(mem, "lidl", "2026-10-17T09:40:00+00:00", status="failed", error="ReadError: x")
    assert due(mem, "2026-10-17T10:40:00+00:00", slots) is True


def test_is_due_stops_after_max_retries(mem, slots):
    for t in ("09:40", "10:40", "11:40"):
        add_run(mem, "lidl", f"2026-10-17T{t}:00+00:00", status="failed", error="ReadError: x")
    assert due(mem, "2026-10-17T12:00:00+00:00", slots) is False
    assert due(mem, "2026-10-17T15:40:00+00:00", slots) is True  # next slot (18:30 local) reached


def test_is_due_block_waits_for_next_slot(mem, slots):
    add_run(mem, "lidl", "2026-10-17T09:40:00+00:00", status="failed", error="HttpBlockedError: 403 Forbidden")
    assert due(mem, "2026-10-17T10:40:00+00:00", slots) is False


def test_is_due_ok_after_failures_not_due(mem, slots):
    add_run(mem, "lidl", "2026-10-17T09:40:00+00:00", status="failed", error="ReadError: x")
    add_run(mem, "lidl", "2026-10-17T10:40:00+00:00", status="ok")
    assert due(mem, "2026-10-17T11:40:00+00:00", slots) is False


def test_is_due_before_first_slot_uses_yesterdays_last_slot(mem, slots):
    # 02:00Z = 05:00 Sofia; yesterday's last slot 18:30 local = 15:30Z on the 16th
    add_run(mem, "lidl", "2026-10-16T15:00:00+00:00")
    assert due(mem, "2026-10-17T02:00:00+00:00", slots) is True
    add_run(mem, "lidl", "2026-10-16T16:00:00+00:00")
    assert due(mem, "2026-10-17T02:00:00+00:00", slots) is False


def test_is_due_spring_forward_2026_03_29(mem, slots):
    # Sofia switches EET (UTC+2) -> EEST (UTC+3) at 03:00 local; 06:30 slot is 03:30Z that day
    add_run(mem, "lidl", "2026-03-29T03:20:00+00:00")
    assert due(mem, "2026-03-29T04:00:00+00:00", slots) is True
    add_run(mem, "lidl", "2026-03-29T03:40:00+00:00")
    assert due(mem, "2026-03-29T04:00:00+00:00", slots) is False
    # 06:00 local (03:00Z): before the slot, yesterday's 18:30 EET slot = 16:30Z on the 28th applies
    add_run(mem, "billa", "2026-03-28T16:00:00+00:00")
    assert due(mem, "2026-03-29T03:00:00+00:00", slots, "billa") is True
    add_run(mem, "billa", "2026-03-28T17:00:00+00:00")
    assert due(mem, "2026-03-29T03:00:00+00:00", slots, "billa") is False


def test_is_due_fall_back_2026_10_25(mem, slots):
    # EEST (UTC+3) -> EET (UTC+2) at 04:00 local; the 06:30 slot is 04:30Z that day
    add_run(mem, "lidl", "2026-10-25T04:00:00+00:00")
    assert due(mem, "2026-10-25T05:00:00+00:00", slots) is True
    add_run(mem, "lidl", "2026-10-25T04:40:00+00:00")
    assert due(mem, "2026-10-25T05:00:00+00:00", slots) is False
    # 06:00 local (04:00Z) is before the slot: yesterday's 18:30 EEST slot = 15:30Z on the 24th
    add_run(mem, "billa", "2026-10-24T15:00:00+00:00")
    assert due(mem, "2026-10-25T04:00:00+00:00", slots, "billa") is True
    add_run(mem, "billa", "2026-10-24T16:00:00+00:00")
    assert due(mem, "2026-10-25T04:00:00+00:00", slots, "billa") is False


def test_scheduled_collect_runs_each_chain_once_per_slot(settings):
    source = FakeSource("lidl")
    assert run_collect(settings, [source], scheduled=True) == 0
    assert source.fetch_calls == 1
    assert run_collect(settings, [source], scheduled=True) == 0
    assert source.fetch_calls == 1  # not due again within the same slot
    assert exported(settings)["meta"]["chains"]["lidl"]["status"] == "ok"  # export still refreshed
    later = datetime(2026, 10, 17, 16, 0, tzinfo=timezone.utc)  # 19:00 local: 18:30 slot reached
    assert run_collect(settings, [source], scheduled=True, now=later) == 0
    assert source.fetch_calls == 2


def test_no_export_flag(settings):
    assert run_collect(settings, [FakeSource("lidl")], export=False) == 0
    assert not (settings.data_dir / "export").exists()
