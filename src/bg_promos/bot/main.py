"""Entry point of the public Telegram bot (long polling, no webhook)."""

from __future__ import annotations

import asyncio
import logging
import os
import re
import signal
import sys

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.types import ErrorEvent
from dotenv import load_dotenv

from ..config import PROJECT_ROOT, load
from .handlers import router

log = logging.getLogger("bg_promos.bot")


_BOT_URL_RE = re.compile(r"bot\d+:[A-Za-z0-9_-]{30,}")
_BARE_TOKEN_RE = re.compile(r"\d+:[A-Za-z0-9_-]{30,}")


def redact(text: str, tokens: tuple[str, ...] = ()) -> str:
    """Replace the known bot tokens and anything token-shaped with a placeholder."""
    for tok in tokens:
        if tok:
            text = text.replace(tok, "<redacted>")
    text = _BOT_URL_RE.sub("bot<redacted>", text)
    return _BARE_TOKEN_RE.sub("<redacted>", text)


class TokenRedactingFilter(logging.Filter):
    """Strip bot tokens from message, args and exception text of every record."""

    def __init__(self, *tokens: str) -> None:
        super().__init__()
        self.tokens = tuple(t for t in tokens if t)

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # broken format/args: keep going, redact the raw msg
            message = str(record.msg)
        record.msg = redact(message, self.tokens)
        record.args = None
        if record.exc_info:
            if not record.exc_text:
                record.exc_text = logging.Formatter().formatException(record.exc_info)
            record.exc_info = None
        if record.exc_text:
            record.exc_text = redact(record.exc_text, self.tokens)
        if record.stack_info:
            record.stack_info = redact(record.stack_info, self.tokens)
        return True


def install_redaction(*tokens: str) -> None:
    """Install the filter on every root handler (idempotent per handler)."""
    for handler in logging.getLogger().handlers:
        for f in list(handler.filters):
            if isinstance(f, TokenRedactingFilter):
                handler.removeFilter(f)
        handler.addFilter(TokenRedactingFilter(*tokens))


def setup_logging(level: str = "INFO", *tokens: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger().setLevel(getattr(logging, level, logging.INFO))
    install_redaction(*tokens)
    # Noisy libraries; httpx/aiohttp would otherwise log request URLs (which contain the token).
    for name in ("httpx", "httpcore", "aiohttp", "aiogram.client"):
        logging.getLogger(name).setLevel(logging.WARNING)


def build_dispatcher() -> Dispatcher:
    dp = Dispatcher()
    dp.include_router(router)

    @dp.error()
    async def on_error(event: ErrorEvent) -> bool:
        # Only the exception type and update id: messages may echo request URLs/tokens.
        log.error("update %s failed: %s", event.update.update_id, type(event.exception).__name__)
        return True

    return dp


async def run(token: str) -> None:
    bot = Bot(token=token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = build_dispatcher()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # Windows event loop
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stop.set))

    polling = asyncio.create_task(
        dp.start_polling(
            bot,
            allowed_updates=dp.resolve_used_update_types(),
            handle_signals=False,
            handle_as_tasks=False,  # sequential: stop_polling waits for the current handler
        )
    )
    waiter = asyncio.create_task(stop.wait())
    try:
        await asyncio.wait({polling, waiter}, return_when=asyncio.FIRST_COMPLETED)
        if polling.done():
            polling.result()
        else:
            log.info("shutdown signal received, stopping")
            await dp.stop_polling()
            await polling
    finally:
        waiter.cancel()
        await bot.session.close()


def main() -> int:
    load_dotenv(PROJECT_ROOT / ".env")
    token = (os.environ.get("PROMOS_BOT_TOKEN") or "").strip()
    setup_logging((os.environ.get("LOG_LEVEL") or "INFO").upper(), token)
    if not token:
        log.warning("PROMOS_BOT_TOKEN is not set — bot disabled")
        return 0
    try:
        settings = load()
    except Exception as exc:  # type only: config errors must not leak values
        log.error("failed to load configuration: %s", type(exc).__name__)
        return 1
    setup_logging(settings.log_level, token, settings.promos_bot_token)
    token = settings.promos_bot_token or token
    log.info("starting @promoseubot (long polling)")
    try:
        asyncio.run(run(token))
    except KeyboardInterrupt:
        pass
    except Exception as exc:  # type only: never leak the token through a message
        log.error("bot crashed: %s", type(exc).__name__)
        return 1
    log.info("bot stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
