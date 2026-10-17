# Быстрый старт

Локальный запуск (Windows, Git Bash):

1. Перейти в папку проекта (или клонировать репозиторий):
   ```bash
   cd /d/1PythonProjects/20261017bg-promos/bg-promos
   ```
2. Создать и активировать виртуальное окружение:
   ```bash
   python -m venv .venv
   source .venv/Scripts/activate
   ```
   PowerShell: `.venv\Scripts\Activate.ps1`. Linux: `source .venv/bin/activate`.
3. Установить зависимости:
   ```bash
   pip install -r requirements-dev.txt && pip install -e .
   ```
4. Создать `.env` из шаблона (обязательных переменных нет):
   ```bash
   cp .env.example .env
   ```
5. Первый сбор данных (вежливо, около 60 запросов к Lidl и по 1-2 к Kaufland и BILLA):
   ```bash
   python -m bg_promos collect
   ```
6. Проверить результат:
   ```bash
   python -m bg_promos stats
   head -c 600 data/export/offers_current.json
   ```
7. Запустить тесты:
   ```bash
   pytest -q
   ```

Этап 2: запуск API и сайта локально (нужны шаги 1-5 выше и Node 22):

1. Запустить API (venv активировано), окно 1:
   ```bash
   python -m uvicorn bg_promos.web.app:app --port 8001
   ```
2. Проверить API:
   ```bash
   curl -s http://127.0.0.1:8001/api/health
   ```
3. Установить зависимости фронтенда и запустить dev-сервер, окно 2 (прокси `/api` на порт 8001 настроен):
   ```bash
   cd web
   npm install
   npm run dev
   ```
4. Открыть http://localhost:5173 (откроется `/bg` или `/ru` по языку браузера).
5. Необязательно: форма ошибок и аналитика. Для формы впишите `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID` в `.env`; для аналитики задайте `ga4_id` в `config.ini` секции `[web]` (пусто = выключено, баннера нет).
6. Тесты фронтенда и продакшн-сборка (в папке `web`):
   ```bash
   npm test
   npm run build
   npm run preview
   ```
   Сборка делает prerender страниц, `sitemap.xml` и `robots.txt` в `web/dist`; предпросмотр на http://localhost:4173.
7. Тесты бэкенда (из корня проекта, venv активировано):
   ```bash
   pytest -q
   ```

Выкатка этапа 2 на сервер: [DEPLOY.md](DEPLOY.md). Упаковка в магазины приложений: [MOBILE_STORES.md](MOBILE_STORES.md).

Вариант Docker на VPS (Ubuntu, Docker уже установлен):

1. Клонировать репозиторий проекта и перейти в папку:
   ```bash
   cd /opt && git clone <адрес-вашего-репозитория> bg-promos && cd /opt/bg-promos
   ```
2. Подготовить `.env` и папку данных:
   ```bash
   cp .env.example .env
   mkdir -p data && sudo chown 1000:1000 data
   ```
3. Собрать образ и сделать первый запуск:
   ```bash
   docker compose build
   docker compose run --rm collector collect
   ```
4. Проверить:
   ```bash
   docker compose run --rm collector stats
   ls data/export
   ```
5. Добавить в cron (`crontab -e`):
   ```
   0 * * * * cd /opt/bg-promos && docker compose run --rm -T collector collect --scheduled >> /opt/bg-promos/data/cron.log 2>&1
   ```
