"""aiogram router: commands, install callbacks, fallback hint (private chats only)."""

from __future__ import annotations

import logging

from aiogram import F, Router
from aiogram.filters import Command, CommandStart
from aiogram.types import CallbackQuery, Message

from ..config import load
from . import keyboards, texts

log = logging.getLogger(__name__)

router = Router(name="promos")


def _webapp_url() -> str:
    return load().bot_webapp_url


@router.message(CommandStart(), F.chat.type == "private")
async def cmd_start(message: Message) -> None:
    await message.answer(texts.START, reply_markup=keyboards.start_keyboard(_webapp_url()))


@router.message(Command("app"), F.chat.type == "private")
async def cmd_app(message: Message) -> None:
    await message.answer(texts.APP, reply_markup=keyboards.open_keyboard(_webapp_url()))


@router.message(Command("install"), F.chat.type == "private")
async def cmd_install(message: Message) -> None:
    await message.answer(texts.INSTALL_CHOOSE, reply_markup=keyboards.install_choice_keyboard())


@router.message(Command("help"), F.chat.type == "private")
async def cmd_help(message: Message) -> None:
    await message.answer(texts.HELP, reply_markup=keyboards.open_keyboard(_webapp_url()))


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
