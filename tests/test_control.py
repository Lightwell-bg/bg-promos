from __future__ import annotations

import sqlite3
from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo

import pytest

from bg_promos.control import (
    ControlStore,
    StaleRevisionError,
    effective_schedule,
    format_slots,
    parse_slots_list,
    validate_schedule,
)
from bg_promos.pipeline import next_slot_instant

SOFIA = ZoneInfo("Europe/Sofia")


@pytest.fixture
def control(tmp_path):
    with ControlStore(tmp_path / "control.sqlite3") as c:
        yield c


def test_revision_conflict_and_monotonic_reset(control):
    assert control.get_schedule("lidl") is None
    assert control.save_schedule("lidl", True, (time(7, 0),), 0) == 1
    with pytest.raises(StaleRevisionError) as exc:
        control.save_schedule("lidl", True, (time(8, 0),), 0)
    assert exc.value.current == 1
    assert control.reset_schedule("lidl", 1) == 2
    row = control.get_schedule("lidl")
    assert (row["overridden"], row["revision"]) == (0, 2)
    with pytest.raises(StaleRevisionError):
        control.reset_schedule("lidl", 1)  # old tab: no ABA
    assert control.save_schedule("lidl", False, (), 2) == 3
    assert [r["chain"] for r in control.all_schedules()] == ["lidl"]


def test_save_enabled_without_slots_rejected(control):
    with pytest.raises(ValueError):
        control.save_schedule("lidl", True, (), 0)
    assert control.get_schedule("lidl") is None


def test_request_dedupe_and_atomic_claim(control):
    first, created = control.request_run("billa")
    assert created is True
    again, created2 = control.request_run("billa")
    assert created2 is False and again["id"] == first["id"]
    assert control.pending_request("billa")["id"] == first["id"]
    assert control.claim_request(first["id"], datetime(2026, 10, 25, 6, 0, tzinfo=timezone.utc)) is True
    assert control.claim_request(first["id"]) is False
    assert control.pending_request("billa") is None
    control.finish_request(first["id"], "ok", 7)
    last = control.last_request("billa")
    assert (last["status"], last["run_id"]) == ("ok", 7) and last["finished_at"]
    new, created3 = control.request_run("billa")  # claimed one no longer blocks a new request
    assert created3 is True and new["id"] != first["id"]


def test_close_orphaned_claims(control):
    now = datetime(2026, 10, 25, 7, 0, tzinfo=timezone.utc)
    orphan, _ = control.request_run("lidl")
    control.claim_request(orphan["id"], now)
    done, _ = control.request_run("billa")
    control.claim_request(done["id"], now)
    control.finish_request(done["id"], "ok", 3, now)
    pending, _ = control.request_run("kaufland")
    assert control.close_orphaned_claims(now) == 1
    closed = control.last_request("lidl")
    assert closed["status"] == "interrupted" and closed["finished_at"]
    assert control.last_request("billa")["status"] == "ok"  # finished one untouched
    assert control.pending_request("kaufland")["id"] == pending["id"]  # pending untouched
    assert control.close_orphaned_claims(now) == 0


def test_slot_validation():
    assert parse_slots_list(["12:30", "06:30", "06:30"]) == (time(6, 30), time(12, 30))
    assert format_slots((time(6, 5), time(23, 59))) == ["06:05", "23:59"]
    for bad in ("24:00", "6:30", "12:60", "12:30:00", "", "ab:cd", " 12:30"):
        with pytest.raises(ValueError):
            parse_slots_list([bad])
    with pytest.raises(ValueError):
        parse_slots_list([f"{h:02d}:00" for h in range(24)] + ["00:30"])
    assert len(parse_slots_list([f"{h:02d}:00" for h in range(24)])) == 24
    with pytest.raises(ValueError):
        validate_schedule(True, [])
    assert validate_schedule(False, []) == ()


def test_effective_schedule_fallback_and_override(settings, control):
    cfg = effective_schedule(settings, None, "lidl")
    assert (cfg.enabled, cfg.source, cfg.revision, cfg.slots) == (True, "config", 0, settings.slots)
    assert effective_schedule(settings, control, "lidl").source == "config"
    control.save_schedule("lidl", True, (time(9, 15),), 0)
    adm = effective_schedule(settings, control, "lidl")
    assert (adm.source, adm.slots, adm.revision) == ("admin", (time(9, 15),), 1) and adm.updated_at
    assert effective_schedule(settings, control, "kaufland").source == "config"  # per chain
    control.save_schedule("lidl", False, (), 1)
    assert effective_schedule(settings, control, "lidl").enabled is False
    control.reset_schedule("lidl", 2)
    back = effective_schedule(settings, control, "lidl")
    assert (back.source, back.slots, back.revision, back.enabled) == ("config", settings.slots, 3, True)


def test_next_slot_instant_basic_and_none():
    slots = (time(6, 30), time(12, 30))
    now = datetime(2026, 10, 17, 10, 0, tzinfo=timezone.utc)  # 13:00 Sofia (EEST)
    assert next_slot_instant(slots, SOFIA, now) == datetime(2026, 10, 18, 3, 30, tzinfo=timezone.utc)
    assert next_slot_instant((), SOFIA, now) is None
    at_slot = datetime(2026, 10, 17, 3, 30, tzinfo=timezone.utc)  # exactly 06:30 Sofia: strictly after
    assert next_slot_instant(slots, SOFIA, at_slot) == datetime(2026, 10, 17, 9, 30, tzinfo=timezone.utc)


def test_next_slot_instant_dst_changes():
    slots = (time(6, 30),)
    # spring forward 2026-03-29 (03:00 -> 04:00): Saturday evening, next 06:30 is EEST (UTC+3)
    now = datetime(2026, 3, 28, 20, 0, tzinfo=timezone.utc)
    assert next_slot_instant(slots, SOFIA, now) == datetime(2026, 3, 29, 3, 30, tzinfo=timezone.utc)
    # day before: still EET (UTC+2)
    assert next_slot_instant(slots, SOFIA, datetime(2026, 3, 27, 20, 0, tzinfo=timezone.utc)) == datetime(
        2026, 3, 28, 4, 30, tzinfo=timezone.utc)
    # fall back 2026-10-25: after the change the slot is UTC+2
    assert next_slot_instant(slots, SOFIA, datetime(2026, 10, 24, 20, 0, tzinfo=timezone.utc)) == datetime(
        2026, 10, 25, 4, 30, tzinfo=timezone.utc)


def test_corrupt_control_file_raises(tmp_path):
    bad = tmp_path / "control.sqlite3"
    bad.write_bytes(b"this is not a database" * 100)
    with pytest.raises(sqlite3.DatabaseError):
        ControlStore(bad)
