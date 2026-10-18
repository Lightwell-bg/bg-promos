from __future__ import annotations

import logging

import pytest

from analytics_helpers import BOT_TOKEN, make_init_data
from bg_promos.analytics.telegram import InitDataError, verify_init_data

NOW = 1_800_000_100.0


def test_valid():
    data = make_init_data(start_param="s_spring-ig")
    v = verify_init_data(data, BOT_TOKEN, now=NOW)
    assert v.user.id == 4242 and v.user.username == "ann_lee" and v.user.language_code == "ru"
    assert v.start_param == "s_spring-ig" and v.auth_date == 1_800_000_000


def test_forged_user_rejected():
    good = make_init_data()
    forged = good.replace("4242", "9999")
    assert forged != good
    with pytest.raises(InitDataError):
        verify_init_data(forged, BOT_TOKEN, now=NOW)


def test_other_token_rejected():
    data = make_init_data(token="999:other-token-other-token-other-token-xx")
    with pytest.raises(InitDataError):
        verify_init_data(data, BOT_TOKEN, now=NOW)


def test_expired_and_future():
    with pytest.raises(InitDataError):
        verify_init_data(make_init_data(auth_date=1_800_000_000 - 90_000), BOT_TOKEN, now=NOW)
    with pytest.raises(InitDataError):
        verify_init_data(make_init_data(auth_date=1_800_000_000 + 4000), BOT_TOKEN, now=NOW)


def test_duplicate_keys_missing_hash_too_long_empty_token():
    data = make_init_data()
    with pytest.raises(InitDataError):
        verify_init_data(data + "&auth_date=1", BOT_TOKEN, now=NOW)
    with pytest.raises(InitDataError):
        verify_init_data(make_init_data(drop_hash=True), BOT_TOKEN, now=NOW)
    with pytest.raises(InitDataError):
        verify_init_data(make_init_data(extra={"pad": "x" * 5000}), BOT_TOKEN, now=NOW)
    with pytest.raises(InitDataError):
        verify_init_data(data, "", now=NOW)
    with pytest.raises(InitDataError):
        verify_init_data("", BOT_TOKEN, now=NOW)


def test_bad_user_payload_rejected():
    with pytest.raises(InitDataError):
        verify_init_data(make_init_data(user={"id": "7"}), BOT_TOKEN, now=NOW)
    with pytest.raises(InitDataError):
        verify_init_data(make_init_data(user={"id": -5}), BOT_TOKEN, now=NOW)


def test_raw_init_data_never_in_exception_or_logs(caplog):
    caplog.set_level(logging.DEBUG)
    data = make_init_data(hash_override="0" * 64, user={"id": 777001, "first_name": "Secretname"})
    with pytest.raises(InitDataError) as exc:
        verify_init_data(data, BOT_TOKEN, now=NOW)
    text = str(exc.value) + repr(exc.value) + caplog.text
    assert "Secretname" not in text and "777001" not in text and "0" * 64 not in text
