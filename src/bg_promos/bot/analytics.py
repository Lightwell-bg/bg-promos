"""Server-side analytics for the bot: one ``bot_start`` event per /start (no consent needed
to answer; the event is recorded from the update itself, never from client data).

Failures here must never break the bot reply: callers wrap everything in try/except.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from ..analytics.attribution import UNKNOWN, parse_label
from ..analytics.events import utc_iso
from ..analytics.store import AnalyticsStore
from ..analytics.telegram import TelegramUser


def _clip(v: Any, n: int) -> str | None:
    return v.strip()[:n] or None if isinstance(v, str) else None


def telegram_user(user: Any) -> TelegramUser | None:
    """aiogram ``User`` -> TelegramUser; None for missing users, bots and non-int ids."""
    uid = getattr(user, "id", None)
    if user is None or isinstance(uid, bool) or not isinstance(uid, int) or uid <= 0:
        return None
    if getattr(user, "is_bot", False) is True:
        return None
    return TelegramUser(
        id=uid,
        username=_clip(getattr(user, "username", None), 64),
        first_name=_clip(getattr(user, "first_name", None), 128),
        last_name=_clip(getattr(user, "last_name", None), 128),
        language_code=_clip(getattr(user, "language_code", None), 16),
        is_bot=False,
    )


_BOT_NS = uuid.UUID("0b6f3c52-8d1a-4e47-9a35-6c2f1e9d7b84")


def update_key(update_id: Any = None, chat_id: Any = None, message_id: Any = None) -> str | None:
    """Stable key of a Telegram update (update_id, else chat+message id); None when unknown."""
    if isinstance(update_id, int) and not isinstance(update_id, bool):
        return f"tg-update:{update_id}"
    ints = (chat_id, message_id)
    if all(isinstance(v, int) and not isinstance(v, bool) for v in ints):
        return f"tg-message:{chat_id}:{message_id}"
    return None


def record_bot_start(store: AnalyticsStore, user: TelegramUser, payload: str | None,
                     now: datetime | None = None, key: str | None = None) -> str:
    """Upsert the Telegram visitor, open a 'bot' session and record ``bot_start``. Returns visitor id.

    With ``key`` (see ``update_key``) the session and event ids are deterministic, so a
    redelivered update creates neither a second session nor a second ``bot_start``.
    """
    now = now or datetime.now(timezone.utc)
    source = parse_label(payload, "start") if payload else UNKNOWN
    if not payload:
        kind = "none"
    elif source is not UNKNOWN:
        kind = "label"
    else:
        kind = "other"
    source_id = store.get_or_create_source(source)
    visitor_id = store.upsert_tg_visitor(user, source_id, now)
    session_id = str(uuid.uuid5(_BOT_NS, f"session:{key}")) if key else str(uuid.uuid4())
    event_id = str(uuid.uuid5(_BOT_NS, f"event:{key}")) if key else str(uuid.uuid4())
    lang = user.language_code.lower()[:8] if user.language_code else None
    store.start_session(session_id, visitor_id, "bot", source_id, lang, False, False, now)
    store.add_events(session_id, visitor_id, "bot", [{
        "event_id": event_id, "name": "bot_start", "ts": utc_iso(now),
        "props": {"payload_kind": kind},
    }])
    return visitor_id
