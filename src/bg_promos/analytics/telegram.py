"""Server-side verification of Telegram Mini App initData.

Spec (core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
  secret_key = HMAC_SHA256(key=b"WebAppData", msg=bot_token)
  check      = HMAC_SHA256(key=secret_key, msg=data_check_string).hexdigest()
  data_check_string = "\n".join(sorted(f"{k}={v}" for k, v in fields if k != "hash"))
The client-side `initDataUnsafe` and any Telegram id sent by the client are never trusted;
only the fields of an initData string whose hash verifies are used. The raw initData is not
stored or logged by this module.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from dataclasses import dataclass
from urllib.parse import parse_qsl

_HEX64 = re.compile(r"[0-9a-fA-F]{64}")
MAX_INIT_DATA_LEN = 4096
DEFAULT_MAX_AGE_S = 24 * 3600  # Telegram re-signs on every launch; older data is a replay


class InitDataError(ValueError):
    """initData is missing, malformed, expired or not signed by our bot."""


@dataclass(frozen=True, slots=True)
class TelegramUser:
    id: int
    username: str | None
    first_name: str | None
    last_name: str | None
    language_code: str | None
    is_bot: bool


@dataclass(frozen=True, slots=True)
class VerifiedInitData:
    user: TelegramUser
    auth_date: int
    start_param: str | None
    chat_type: str | None


def _clip(v: object, n: int) -> str | None:
    if not isinstance(v, str):
        return None
    v = v.strip()
    return v[:n] or None


def verify_init_data(
    init_data: str,
    bot_token: str,
    *,
    now: float | None = None,
    max_age_s: int = DEFAULT_MAX_AGE_S,
) -> VerifiedInitData:
    """Return the verified user, or raise InitDataError (message never contains the data)."""
    if not bot_token:
        raise InitDataError("bot token not configured")
    if not init_data or len(init_data) > MAX_INIT_DATA_LEN:
        raise InitDataError("initData missing or too long")
    pairs = parse_qsl(init_data, keep_blank_values=True, strict_parsing=False)
    fields: dict[str, str] = {}
    for k, v in pairs:
        if k in fields:  # duplicate keys make the check string ambiguous
            raise InitDataError("duplicate field")
        fields[k] = v
    received = fields.pop("hash", None)
    if not received or not _HEX64.fullmatch(received):  # ASCII hex only: compare_digest rejects non-ASCII str
        raise InitDataError("hash missing")
    # `signature` (third-party Ed25519 validation) is part of the check string like any field.
    check_string = "\n".join(f"{k}={fields[k]}" for k in sorted(fields))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    expected = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected.encode("ascii"), received.lower().encode("ascii")):
        raise InitDataError("bad signature")

    try:
        auth_date = int(fields.get("auth_date", ""))
    except ValueError as exc:
        raise InitDataError("auth_date missing") from exc
    current = time.time() if now is None else now
    if auth_date > current + 300 or current - auth_date > max_age_s:
        raise InitDataError("initData expired")

    try:
        raw_user = json.loads(fields.get("user", ""))
    except (ValueError, TypeError) as exc:
        raise InitDataError("user missing") from exc
    if not isinstance(raw_user, dict) or not isinstance(raw_user.get("id"), int) or raw_user["id"] <= 0:
        raise InitDataError("user missing")
    user = TelegramUser(
        id=raw_user["id"],
        username=_clip(raw_user.get("username"), 64),
        first_name=_clip(raw_user.get("first_name"), 128),
        last_name=_clip(raw_user.get("last_name"), 128),
        language_code=_clip(raw_user.get("language_code"), 16),
        is_bot=raw_user.get("is_bot") is True,
    )
    return VerifiedInitData(
        user=user,
        auth_date=auth_date,
        start_param=_clip(fields.get("start_param"), 512),
        chat_type=_clip(fields.get("chat_type"), 32),
    )
