"""Public Telegram bot: texts, keyboards, handlers, startup (no network)."""

from __future__ import annotations

import asyncio
import functools
import logging
from unittest.mock import AsyncMock, MagicMock

import pytest

from bg_promos.bot import handlers, keyboards, main as bot_main, texts
from bg_promos.config import load

URL = "https://promos.centerai.eu"


def sync(fn):
    """Run an async test with asyncio.run (no pytest-asyncio dependency)."""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        return asyncio.run(fn(*args, **kwargs))

    return wrapper


@pytest.fixture(autouse=True)
def _fixed_url(monkeypatch):
    monkeypatch.setattr(handlers, "_webapp_url", lambda: URL)


def make_message(chat_type: str = "private") -> MagicMock:
    msg = MagicMock()
    msg.chat.type = chat_type
    msg.answer = AsyncMock()
    msg.answer_photo = AsyncMock()
    return msg


def make_callback(data: str) -> MagicMock:
    q = MagicMock()
    q.data = data
    q.answer = AsyncMock()
    q.message = MagicMock()
    q.message.answer = AsyncMock()
    return q


def buttons(markup):
    return [row[0] for row in markup.inline_keyboard]


def test_start_text_exact():
    assert texts.START == (
        "🛒 Добро пожаловать в BG Promos!\n\nАкции Lidl, Kaufland и BILLA в одном приложении. "
        "Ищите скидки, смотрите предложения и собирайте корзину покупок."
    )


def test_keyboards():
    b = buttons(keyboards.start_keyboard(URL))
    assert [x.text for x in b] == [texts.BTN_OPEN, texts.BTN_IOS, texts.BTN_ANDROID]
    assert b[0].web_app.url == URL
    assert b[1].callback_data == "install:ios"
    assert b[2].callback_data == "install:android"
    assert all(len(r) == 1 for r in keyboards.start_keyboard(URL).inline_keyboard)
    ib = buttons(keyboards.instruction_keyboard(URL))
    assert ib[0].web_app.url == URL
    assert ib[1].text == "⬅️ Назад" and ib[1].callback_data == "install:menu"


def test_instruction_texts_and_escaping():
    ios = texts.install_ios(URL)
    assert ios.startswith("<b>Установка на iPhone</b>")
    assert f"Откройте {URL} в <b>Safari</b>." in ios
    assert "«На экран „Домой“»" in ios
    assert ios.endswith(texts.CART_NOTE)
    android = texts.install_android(URL)
    assert "<b>Google Chrome</b>" in android and android.endswith(texts.CART_NOTE)
    evil = texts.install_ios('https://x.test/?a=1&b=<script>')
    assert "<script>" not in evil and "&amp;b=&lt;script&gt;" in evil


@sync
async def test_start_uses_answer_not_photo():
    msg = make_message()
    await handlers.cmd_start(msg)
    msg.answer.assert_awaited_once()
    msg.answer_photo.assert_not_called()
    assert msg.answer.await_args.args[0] == texts.START
    assert len(buttons(msg.answer.await_args.kwargs["reply_markup"])) == 3


@sync
async def test_app_install_help():
    m = make_message()
    await handlers.cmd_app(m)
    assert m.answer.await_args.args[0] == texts.APP
    m = make_message()
    await handlers.cmd_install(m)
    assert m.answer.await_args.args[0] == texts.INSTALL_CHOOSE
    m = make_message()
    await handlers.cmd_help(m)
    text = m.answer.await_args.args[0]
    assert "/start" in text and "/app" in text and "/install" in text and "/help" in text
    assert "отдельно" in text
    assert text.endswith(
        "ℹ️ При /start бот сохраняет ваш Telegram ID, имя и источник перехода для статистики. "
        "Подробнее: https://promos.centerai.eu/ru/legal/privacy"
    )


@pytest.mark.parametrize(
    "data,expected",
    [
        ("install:ios", texts.install_ios(URL)),
        ("install:android", texts.install_android(URL)),
        ("install:menu", texts.INSTALL_CHOOSE),
    ],
)
@sync
async def test_install_callbacks(data, expected):
    q = make_callback(data)
    await handlers.cb_install(q)
    q.answer.assert_awaited_once_with()
    assert q.message.answer.await_args.args[0] == expected


@sync
async def test_unknown_callback_answered_silently():
    q = make_callback("whatever")
    await handlers.cb_unknown(q)
    q.answer.assert_awaited_once_with()
    q.message.answer.assert_not_called()


@sync
async def test_other_text_hint_private():
    m = make_message()
    await handlers.other_text(m)
    assert m.answer.await_args.args[0] == texts.OTHER_TEXT_HINT


def test_group_text_is_filtered_out():
    # Every message handler carries the private-chat filter F.chat.type == "private".
    for h in handlers.router.message.handlers:
        magic = h.filters[-1].magic
        assert magic.resolve(make_message("private"))
        assert not magic.resolve(make_message("group"))
        assert not magic.resolve(make_message("supergroup"))


def test_config_token_never_falls_back(monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "111:technical")
    monkeypatch.setenv("PROMOS_BOT_TOKEN", "")
    assert load().promos_bot_token == ""
    monkeypatch.setenv("PROMOS_BOT_TOKEN", " 222:public ")
    s = load()
    assert s.promos_bot_token == "222:public" and s.telegram_bot_token == "111:technical"
    assert s.bot_webapp_url == URL


def test_missing_token_exits_zero_without_network(monkeypatch, caplog):
    monkeypatch.setenv("PROMOS_BOT_TOKEN", "")
    boom = MagicMock(side_effect=AssertionError("network/bot must not start"))
    monkeypatch.setattr(bot_main, "run", boom)
    with caplog.at_level(logging.WARNING):
        assert bot_main.main() == 0
    boom.assert_not_called()
    assert "PROMOS_BOT_TOKEN is not set" in caplog.text


@pytest.mark.parametrize("config", ["missing", "invalid"])
def test_missing_token_exits_zero_regardless_of_config(monkeypatch, tmp_path, config):
    monkeypatch.setenv("PROMOS_BOT_TOKEN", "")
    cfg = tmp_path / "config.ini"
    if config == "invalid":
        cfg.write_text("[[[ not an ini\n", encoding="utf-8")
    monkeypatch.setenv("BG_PROMOS_CONFIG", str(cfg))
    boom = MagicMock(side_effect=AssertionError("must not start"))
    monkeypatch.setattr(bot_main, "run", boom)
    assert bot_main.main() == 0
    boom.assert_not_called()


def test_token_set_but_config_broken_exits_one(monkeypatch):
    monkeypatch.setenv("PROMOS_BOT_TOKEN", "123456:" + "A" * 35)
    monkeypatch.setattr(bot_main, "load", MagicMock(side_effect=ValueError("secret")))
    boom = MagicMock()
    monkeypatch.setattr(bot_main, "run", boom)
    assert bot_main.main() == 1
    boom.assert_not_called()


def test_redacting_filter_hides_token_in_exception(capsys):
    import io

    token = "123456:" + "ABCdef_ghi-" * 4
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    handler.addFilter(bot_main.TokenRedactingFilter(token))
    lg = logging.getLogger("test_redact")
    lg.propagate = False
    lg.addHandler(handler)
    try:
        try:
            raise RuntimeError(f"fail https://api.telegram.org/bot{token}/getUpdates")
        except RuntimeError:
            lg.exception("polling failed for %s", token)
        lg.error("bare %s here", "999999:" + "Z" * 40)
    finally:
        lg.removeHandler(handler)
    out = stream.getvalue()
    assert token not in out and "ABCdef_ghi-ABCdef" not in out and "Z" * 30 not in out
    assert "<redacted>" in out and "bot<redacted>/getUpdates" in out


def test_install_redaction_on_root_handlers():
    h = logging.StreamHandler()
    root = logging.getLogger()
    root.addHandler(h)
    try:
        bot_main.install_redaction("tok")
        assert any(isinstance(f, bot_main.TokenRedactingFilter) for f in h.filters)
    finally:
        root.removeHandler(h)


@sync
async def test_polling_not_handled_as_tasks(monkeypatch):
    dp = MagicMock()
    dp.resolve_used_update_types.return_value = ["message"]
    dp.start_polling = AsyncMock()
    dp.stop_polling = AsyncMock()
    monkeypatch.setattr(bot_main, "build_dispatcher", lambda: dp)
    monkeypatch.setattr(bot_main, "ensure_polling_mode", AsyncMock())
    await bot_main.run("123456:" + "A" * 35)
    assert dp.start_polling.await_args.kwargs["handle_as_tasks"] is False


@sync
async def test_webhook_is_removed_before_polling(caplog):
    bot = MagicMock()
    bot.get_me = AsyncMock(return_value=MagicMock(username="promoseubot"))
    bot.get_webhook_info = AsyncMock(return_value=MagicMock(url="https://n8n.example.org/webhook/secret-path"))
    bot.delete_webhook = AsyncMock()
    with caplog.at_level(logging.INFO, logger="bg_promos.bot"):
        await bot_main.ensure_polling_mode(bot)
    bot.delete_webhook.assert_awaited_once_with(drop_pending_updates=False)
    assert "n8n.example.org" in caplog.text
    assert "secret-path" not in caplog.text  # only the host is logged


@sync
async def test_no_webhook_nothing_deleted():
    bot = MagicMock()
    bot.get_me = AsyncMock(return_value=MagicMock(username="promoseubot"))
    bot.get_webhook_info = AsyncMock(return_value=MagicMock(url=""))
    bot.delete_webhook = AsyncMock()
    await bot_main.ensure_polling_mode(bot)
    bot.delete_webhook.assert_not_awaited()
