"""aiogram router: commands, install callbacks, fallback hint (private chats only)."""

from __future__ import annotations

import asyncio
import logging

from aiogram import F, Router
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import CallbackQuery, Message, Update

from ..analytics.store import AnalyticsStore
from ..config import load
from . import keyboards, texts
from .analytics import record_bot_start, telegram_user, update_key

log = logging.getLogger(__name__)

router = Router(name="promos")


def _webapp_url() -> str:
    return load().bot_webapp_url


def _analytics_store() -> AnalyticsStore | None:
    settings = load()
    if not settings.analytics_enabled:
        return None
    return AnalyticsStore(settings.analytics_db_path, settings.timezone)


def _record_start(user, payload: str | None, key: str | None = None) -> None:
    """Blocking part of the analytics write (run in a thread)."""
    tg_user = telegram_user(user)
    store = _analytics_store() if tg_user else None
    if tg_user and store:
        record_bot_start(store, tg_user, payload, key=key)


@router.message(CommandStart(), F.chat.type == "private")
async def cmd_start(message: Message, command: CommandObject | None = None,
                    event_update: Update | None = None) -> None:
    await message.answer(texts.START, reply_markup=keyboards.start_keyboard(_webapp_url()))
    try:  # analytics must never break the reply; log the error class only
        payload = command.args if command is not None and isinstance(command.args, str) else None
        key = update_key(getattr(event_update, "update_id", None), getattr(message.chat, "id", None),
                         getattr(message, "message_id", None))
        await asyncio.to_thread(_record_start, message.from_user, payload, key)
    except Exception as exc:
        log.warning("analytics bot_start failed: %s", type(exc).__name__)


@router.message(Command("app"), F.chat.type == "private")
async def cmd_app(message: Message) -> None:
    await message.answer(texts.APP, reply_markup=keyboards.open_keyboard(_webapp_url()))


@router.message(Command("install"), F.chat.type == "private")
async def cmd_install(message: Message) -> None:
    await message.answer(texts.INSTALL_CHOOSE, reply_markup=keyboards.install_choice_keyboard())


@router.message(Command("help"), F.chat.type == "private")
async def cmd_help(message: Message) -> None:
    await message.answer(texts.help_text(_webapp_url()),reply_markup=keyboards.open_keyboard(_webapp_url()))


@router.callback_query(F.data.startswith("install:"))
async def cb_install(query: CallbackQuery) -> None:
    data = query.data
    await query.answer()
    msg = query.message
    if msg is None or not hasattr(msg, "answer"):
        return
    url = _webapp_url()
    if data == keyboards.CB_IOS:
        await msg.answer(texts.install_ios(url), reply_markup=keyboards.instruction_keyboard(url))
    elif data == keyboards.CB_ANDROID:
        await msg.answer(texts.install_android(url), reply_markup=keyboards.instruction_keyboard(url))
    elif data == keyboards.CB_MENU:
        await msg.answer(texts.INSTALL_CHOOSE, reply_markup=keyboards.install_choice_keyboard())
    else:
        log.debug("unknown install callback data")


@router.callback_query()
async def cb_unknown(query: CallbackQuery) -> None:
    log.debug("unknown callback data")
    await query.answer()


@router.message(F.text, F.chat.type == "private")
async def other_text(message: Message) -> None:
    await message.answer(texts.OTHER_TEXT_HINT)
