from __future__ import annotations

import gzip
import json
import os
import time
from datetime import date, datetime, timezone
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

from conftest import make_offer, seed

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


# ---- guard counts offers active on the run's Sofia date -----------------------------------

CUR = (date(2026, 10, 12), date(2026, 10, 18))   # active on NOW (2026-10-17)
FUT = (date(2026, 10, 19), date(2026, 10, 25))   # next week: future-only on NOW


class WeekSource:
    """Source with ``current`` offers active on NOW, ``future`` next-week ones and ``undated`` ones."""

    chain = "kaufland"

    def __init__(self, current=0, future=0, undated=0, current_window=CUR):
        self.current, self.future, self.undated, self.window = current, future, undated, current_window

    def fetch(self, http):
        return [RawDocument("doc", "https://example.test/", f"{self.current}-{self.future}-{self.undated}".encode())]

    def parse(self, docs):
        out = [make_offer(chain="kaufland", key=f"c{i}", valid_from=self.window[0], valid_to=self.window[1])
               for i in range(self.current)]
        out += [make_offer(chain="kaufland", key=f"f{i}", valid_from=FUT[0], valid_to=FUT[1]) for i in range(self.future)]
        out += [make_offer(chain="kaufland", key=f"u{i}", valid_from=None, valid_to=None) for i in range(self.undated)]
        return out


def _history(settings, n=3, **kw):
    settings.chains["kaufland"].min_expected_offers = 1
    for _ in range(n):
        assert run_collect(settings, [WeekSource(**kw)]) == 0


def test_monday_scenario_drop_of_total_but_not_of_active_is_ok(settings):
    _history(settings, current=100, future=100)  # late-week runs: 200 total, 100 active
    assert run_collect(settings, [WeekSource(current=68)]) == 0  # Monday: 68 total/active >= 60 % of 100
    assert runs(settings, "kaufland")[-1]["status"] == "ok"


def test_broken_run_with_few_active_offers_is_suspicious(settings):
    _history(settings, current=100, future=100)
    assert run_collect(settings, [WeekSource(current=30)]) == 1
    last = runs(settings, "kaufland")[-1]
    assert last["status"] == "suspicious" and "active" in last["error"] and "median" in last["error"]


def test_future_only_spike_does_not_mask_broken_run(settings):
    _history(settings, current=100, future=100)
    assert run_collect(settings, [WeekSource(current=30, future=300)]) == 1  # 330 total, only 30 active
    assert runs(settings, "kaufland")[-1]["status"] == "suspicious"


def test_floor_applies_to_active_count(settings):
    settings.chains["kaufland"].min_expected_offers = 50
    assert run_collect(settings, [WeekSource(current=10, future=100)]) == 1
    last = runs(settings, "kaufland")[-1]
    assert last["status"] == "suspicious" and "only 10 offers active" in last["error"]
    assert last["offers_count"] == 110


def test_offers_without_dates_count_as_active(settings):
    _history(settings, undated=10)
    assert run_collect(settings, [WeekSource(undated=6)]) == 0   # exactly 60 %
    assert run_collect(settings, [WeekSource(undated=4)]) == 1   # below 60 %


def test_run_day_is_the_sofia_date_at_midnight(settings):
    _history(settings, current=10)
    # 20:30 UTC on 17 Oct = 23:30 in Sofia (EEST, UTC+3): offers valid until the 17th are still active.
    late = datetime(2026, 10, 17, 20, 30, tzinfo=timezone.utc)
    assert run_collect(settings, [WeekSource(current=10, current_window=(date(2026, 10, 12), date(2026, 10, 17)))],
                       now=late) == 0
    # 21:30 UTC = 00:30 on the 18th in Sofia: the same offers have ended -> 0 active.
    after = datetime(2026, 10, 17, 21, 30, tzinfo=timezone.utc)
    assert run_collect(settings, [WeekSource(current=10, current_window=(date(2026, 10, 12), date(2026, 10, 17)))],
                       now=after) == 1
    last = runs(settings, "kaufland")[-1]
    assert last["status"] == "suspicious" and "active on 2026-10-18" in last["error"]


def test_history_without_active_count_is_ignored(settings):
    """Old ok runs (active_count NULL) are excluded; with no usable history only the floor applies."""
    settings.chains["kaufland"].min_expected_offers = 1
    for _ in range(3):
        seed(settings, "kaufland", [make_offer(chain="kaufland", key=str(i)) for i in range(500)])
    with Storage(settings.db_path) as st:
        st.conn.execute("UPDATE scrape_runs SET active_count = NULL")
        st.conn.commit()
        assert st.recent_ok_active_counts("kaufland", 5) == []
    assert run_collect(settings, [WeekSource(current=5)]) == 0


def test_migration_v1_adds_active_count_without_backfill(tmp_path):
    import sqlite3

    path = tmp_path / "old.sqlite3"
    st = Storage(path)
    run_id = st.start_run("kaufland")
    st.save_offers(run_id, "kaufland", [
        make_offer(chain="kaufland", key="a", valid_from=date(2026, 10, 1), valid_to=date(2026, 10, 30)),
        make_offer(chain="kaufland", key="b", valid_from=date(2090, 1, 1), valid_to=date(2090, 1, 7)),
        make_offer(chain="kaufland", key="c", valid_from=None, valid_to=None),
    ])
    st.finish_run(run_id, "ok", 3)
    st.conn.execute("UPDATE scrape_runs SET started_at = '2026-10-17T10:00:00+00:00'")
    st.conn.commit()
    st.close()
    raw = sqlite3.connect(path)  # downgrade to a v1 database: no column, version 1
    raw.execute("ALTER TABLE scrape_runs DROP COLUMN active_count")
    raw.execute("PRAGMA user_version = 1")
    raw.commit()
    raw.close()
    with Storage(path) as st:
        assert st.recent_ok_active_counts("kaufland", 5) == []  # old runs stay NULL
        assert st.conn.execute("SELECT active_count FROM scrape_runs").fetchone()[0] is None
    with Storage(path) as st:  # idempotent
        assert st.recent_ok_active_counts("kaufland", 5) == []


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


# ---- admin control (per-chain schedule override, "collect now") ------------------------------


def control_rw(settings):
    from bg_promos.control import ControlStore

    return ControlStore(settings.control_db_path)


def test_admin_disabled_chain_is_skipped(settings):
    with control_rw(settings) as c:
        c.save_schedule("lidl", False, (), 0)
    lidl, kauf = FakeSource("lidl"), FakeSource("kaufland")
    assert run_collect(settings, [lidl, kauf], scheduled=True) == 0
    assert lidl.fetch_calls == 0 and kauf.fetch_calls == 1


def test_admin_slots_override_config_slots(settings):
    from datetime import time as dtime

    # config slots (06:30/12:30/18:30 Sofia) make lidl due at 10:00 UTC; the override has a later slot only
    with control_rw(settings) as c:
        c.save_schedule("lidl", True, (dtime(20, 0),), 0)
    lidl = FakeSource("lidl")
    assert run_collect(settings, [lidl], scheduled=True, now=datetime(2026, 10, 17, 10, 0, tzinfo=timezone.utc)) == 0
    # 20:00 Sofia yesterday is the last passed slot and nothing ran since: due
    assert lidl.fetch_calls == 1
    assert run_collect(settings, [lidl], scheduled=True, now=datetime(2026, 10, 17, 10, 30, tzinfo=timezone.utc)) == 0
    assert lidl.fetch_calls == 1  # the 12:30 config slot is not used: not due


def test_pending_request_runs_not_due_chain_and_is_finished(settings):
    lidl = FakeSource("lidl")
    run_collect(settings, [lidl], scheduled=True)
    assert lidl.fetch_calls == 1
    run_collect(settings, [lidl], scheduled=True)
    assert lidl.fetch_calls == 1  # not due
    with control_rw(settings) as c:
        req, _ = c.request_run("lidl")
    assert run_collect(settings, [lidl], scheduled=True) == 0
    assert lidl.fetch_calls == 2
    with control_rw(settings) as c:
        done = c.last_request("lidl")
        assert c.pending_request("lidl") is None
    assert (done["id"], done["status"]) == (req["id"], "ok")
    assert done["claimed_at"] and done["finished_at"]
    assert done["run_id"] == runs(settings, "lidl")[-1]["id"]
    run_collect(settings, [lidl], scheduled=True)
    assert lidl.fetch_calls == 2  # one request = one run


def test_finish_request_uses_run_completion_time(settings, monkeypatch):
    lidl = FakeSource("lidl")
    with control_rw(settings) as c:
        c.request_run("lidl")
    # the run finishes 5 hours after the invocation time
    monkeypatch.setattr("bg_promos.storage.utcnow", lambda: "2026-10-17T15:00:00+00:00")
    assert collect(settings, sources={"lidl": lidl}, scheduled=True, now=NOW) == 0
    with control_rw(settings) as c:
        done = c.last_request("lidl")
    assert done["finished_at"] == "2026-10-17T15:00:00+00:00" == runs(settings, "lidl")[-1]["finished_at"]
    assert done["claimed_at"] != done["finished_at"]


def test_scheduled_run_closes_orphaned_claims_first(settings):
    with control_rw(settings) as c:
        req, _ = c.request_run("lidl")
        assert c.claim_request(req["id"])  # claimed, then the collector "crashed"
    lidl = FakeSource("lidl")
    run_collect(settings, [lidl], scheduled=True)
    with control_rw(settings) as c:
        old = c.conn.execute("SELECT * FROM collect_requests WHERE id = ?", (req["id"],)).fetchone()
    assert old["status"] == "interrupted" and old["finished_at"]
    assert lidl.fetch_calls == 1  # first-ever run is due by schedule, not re-run for the orphan


def test_pending_request_runs_admin_disabled_chain_and_records_failure(settings):
    with control_rw(settings) as c:
        c.save_schedule("lidl", False, (), 0)
        c.request_run("lidl")
    lidl = FakeSource("lidl", error=RuntimeError("boom"))
    assert run_collect(settings, [lidl], scheduled=True) == 1
    with control_rw(settings) as c:
        assert c.last_request("lidl")["status"] == "failed"


def test_non_scheduled_ignores_control_db(settings):
    with control_rw(settings) as c:
        c.save_schedule("lidl", False, (), 0)
        c.request_run("lidl")
    lidl = FakeSource("lidl")
    assert run_collect(settings, [lidl]) == 0
    assert lidl.fetch_calls == 1
    with control_rw(settings) as c:
        assert c.pending_request("lidl") is not None  # untouched


@pytest.mark.parametrize("kind", ["directory", "garbage"])
def test_broken_control_db_falls_back_to_config(settings, kind):
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    if kind == "directory":
        settings.control_db_path.mkdir()
    else:
        settings.control_db_path.write_bytes(b"not a sqlite file" * 200)
    lidl = FakeSource("lidl")
    assert run_collect(settings, [lidl], scheduled=True) == 0
    assert lidl.fetch_calls == 1
    assert run_collect(settings, [lidl], scheduled=True) == 0
    assert lidl.fetch_calls == 1  # config slots still decide "not due"
