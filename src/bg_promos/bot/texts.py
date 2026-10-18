"""All user-facing texts of the public bot (HTML parse mode, Russian).

Dynamic values (the site URL) are always passed through html.escape.
"""

from __future__ import annotations

from html import escape

START = (
    "🛒 Добро пожаловать в BG Promos!\n\n"
    "Акции Lidl, Kaufland и BILLA в одном приложении. "
    "Ищите скидки, смотрите предложения и собирайте корзину покупок."
)

APP = "Откройте BG Promos прямо в Telegram:"

INSTALL_CHOOSE = "Как установить BG Promos на телефон? Выберите устройство:"

OTHER_TEXT_HINT = "Нажмите /start или откройте приложение кнопкой «Открыть»"

BTN_OPEN = "🛒 Открыть BG Promos"
BTN_IOS = "🍏 Установка на iPhone"
BTN_ANDROID = "🤖 Установка на Android"
BTN_BACK = "⬅️ Назад"

CART_NOTE = (
    "ℹ️ Корзина в установленном приложении (сайте/PWA) и в Telegram Mini App "
    "хранится отдельно и пока не синхронизируется. Чтобы перенести корзину, "
    "используйте кнопку «Поделиться» в корзине."
)

def help_text(url: str) -> str:
    """Help text; the privacy link is built from the configured webapp URL."""
    privacy = escape(url.rstrip("/") + "/ru/legal/privacy")
    return (
        "<b>BG Promos</b> — акции Lidl, Kaufland и BILLA в одном приложении.\n\n"
        "Что умеет приложение: поиск и фильтры по акциям, корзина с суммами по магазинам, "
        "отправка корзины ссылкой.\n\n"
        + CART_NOTE
        + "\n\n<b>Команды</b>\n"
        "/start — начать\n"
        "/app — открыть приложение\n"
        "/install — установка на телефон\n"
        "/help — справка\n\n"
        "ℹ️ При /start бот сохраняет ваш Telegram ID, имя и источник перехода для "
        f"статистики. Подробнее: {privacy}"
    )


def install_ios(url: str) -> str:
    return (
        "<b>Установка на iPhone</b>\n\n"
        f"1. Откройте {escape(url)} в <b>Safari</b>.\n"
        "2. Нажмите «Поделиться» (квадрат со стрелкой вверх).\n"
        "3. Выберите «На экран „Домой“».\n"
        "4. Нажмите «Добавить».\n"
        "5. Запускайте BG Promos с появившейся иконки."
        "\n\n" + CART_NOTE
    )


def install_android(url: str) -> str:
    return (
        "<b>Установка на Android</b>\n\n"
        f"1. Откройте {escape(url)} в <b>Google Chrome</b>.\n"
        "2. Нажмите ⋮ (меню Chrome).\n"
        "3. Выберите «Установить приложение» или «Добавить на главный экран».\n"
        "4. Подтвердите установку.\n"
        "5. Запускайте BG Promos с иконки."
        "\n\n" + CART_NOTE
    )
