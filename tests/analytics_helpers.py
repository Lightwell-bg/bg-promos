"""Shared helpers for the analytics tests (not a test module)."""

from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from urllib.parse import urlencode

BOT_TOKEN = "123456:TEST-token-for-unit-tests-only-0123456789"


def make_init_data(token: str = BOT_TOKEN, *, user: dict | None = None, auth_date: int = 1_800_000_000,
                   start_param: str | None = None, extra: dict | None = None, hash_override: str | None = None,
                   drop_hash: bool = False) -> str:
    """Build a correctly signed Telegram initData string."""
    fields = {"auth_date": str(auth_date), "query_id": "AAH-test"}
    fields["user"] = json.dumps(user or {"id": 4242, "first_name": "Ann", "last_name": "Lee",
                                         "username": "ann_lee", "language_code": "ru"}, separators=(",", ":"))
    if start_param is not None:
        fields["start_param"] = start_param
    fields.update(extra or {})
    check = "\n".join(f"{k}={fields[k]}" for k in sorted(fields))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    digest = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    if not drop_hash:
        fields["hash"] = hash_override or digest
    return urlencode(fields)


def uid() -> str:
    return str(uuid.uuid4())
