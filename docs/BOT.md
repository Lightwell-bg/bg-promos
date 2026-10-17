# Telegram-бот @promoseubot

Публичный бот BG Promos на Python + aiogram 3. Работает через long polling: вебхук, Nginx, порты, БД и авторизация не нужны. Профиль, описание и меню команд уже настроены в @BotFather; бот их не меняет.

## Что делает

- `/start` — приветствие и кнопки: «Открыть BG Promos» (Telegram Mini App на `webapp_url`), «Установка на iPhone», «Установка на Android».
- `/app` — кнопка открытия приложения.
- `/install` — выбор устройства, затем инструкция по установке PWA (кнопки «Открыть» и «Назад»).
- `/help` — краткая справка и список команд.
- Любой другой текст в личном чате — подсказка нажать /start. В группах бот молчит.

Адрес приложения берётся из `config.ini`, секция `[bot]`, ключ `webapp_url` (по умолчанию `https://promos.centerai.eu`).

## Переменные окружения

| Переменная | Значение |
|---|---|
| `PROMOS_BOT_TOKEN` | Токен @promoseubot из @BotFather. Это НЕ `TELEGRAM_BOT_TOKEN` (технический бот уведомлений); запасного перехода на него нет. Пусто = бот отключён (логирует «PROMOS_BOT_TOKEN is not set — bot disabled» и завершается с кодом 0). |

Токен вписывается только в `.env` (шаблон — `.env.example`). В логи токен не попадает.

## Локальный запуск

```bash
source .venv/Scripts/activate
pip install -r requirements.txt
python -m bg_promos.bot
```

Остановка: Ctrl+C (корректное завершение по SIGINT/SIGTERM).

## Запуск на VPS (Docker Compose)

```bash
cd /opt/bg-promos
docker compose build bot && docker compose up -d bot
docker compose logs -f bot
docker compose stop bot
```

Сервис `bot` использует свой образ `bg-promos-bot` (образ collector не перетегируется), `restart: on-failure`: при пустом токене контейнер завершается с кодом 0 и остаётся остановленным, при падении перезапускается. Логи — json-file, 10 МБ x 3 файла.

## Важно

- На один токен допускается только ОДИН экземпляр с polling. Перед запуском на VPS остановите локальный запуск, иначе Telegram вернёт конфликт `getUpdates`.
- Вебхук не используется и не должен быть установлен для этого бота.
- Корзина в PWA/на сайте и в Telegram Mini App хранится отдельно и не синхронизируется — это отражено в текстах бота.
