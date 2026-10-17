"""Inline keyboards (one button per row)."""

from __future__ import annotations

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo

from . import texts

CB_IOS = "install:ios"
CB_ANDROID = "install:android"
CB_MENU = "install:menu"


def _open_button(webapp_url: str) -> InlineKeyboardButton:
    return InlineKeyboardButton(text=texts.BTN_OPEN, web_app=WebAppInfo(url=webapp_url))


def _ios_button() -> InlineKeyboardButton:
    return InlineKeyboardButton(text=texts.BTN_IOS, callback_data=CB_IOS)


def _android_button() -> InlineKeyboardButton:
    return InlineKeyboardButton(text=texts.BTN_ANDROID, callback_data=CB_ANDROID)


def start_keyboard(webapp_url: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[[_open_button(webapp_url)], [_ios_button()], [_android_button()]]
    )


def open_keyboard(webapp_url: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[[_open_button(webapp_url)]])


def install_choice_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[[_ios_button()], [_android_button()]])


def instruction_keyboard(webapp_url: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [_open_button(webapp_url)],
            [InlineKeyboardButton(text=texts.BTN_BACK, callback_data=CB_MENU)],
        ]
    )
