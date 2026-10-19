# BG Promos

Сборщики актуальных акционных предложений болгарских торговых сетей **Lidl**, **Kaufland** и **BILLA**.
Предложения разбираются в единую модель, сохраняются в SQLite (с историей цен) и выгружаются в JSON-файлы.

Документация: [Быстрый старт](docs/QUICK_START.md) | [Выкатка](docs/DEPLOY.md) | [API](docs/API.md) | [Магазины приложений](docs/MOBILE_STORES.md) | [Исследование источников](docs/SOURCES.md) | [Прогресс](docs/PROGRESS.md) | [English README](README.md)

## Охват

- **Этап 1 (готов):** сборщики для трёх сетей -> SQLite -> JSON-экспорт; запуск по расписанию; проверки полноты; признак устаревших данных.
- **Этап 2 (готов, выкатка ожидается):** публичный API только для чтения (FastAPI) и мобильное PWA (React + Vite + TypeScript) на `https://promos.centerai.eu`: каталог, поиск, фильтры, страницы категорий, брошюры, правовые страницы на болгарском и русском, форма сообщения об ошибке (Telegram), необязательная Google Analytics 4 с согласием, prerender при сборке для SEO.
- **Будущие этапы (не начаты):** сопоставление одного товара между сетями, сравнение цен, уведомления, упаковка в магазины приложений ([docs/MOBILE_STORES.md](docs/MOBILE_STORES.md)).

## Стек

Python 3.12+, `httpx` (HTTP), `beautifulsoup4` (HTML), `python-dotenv`, `tzdata`, SQLite (stdlib, WAL), `pytest`. API: FastAPI + uvicorn. Фронтенд: React 18, Vite 5, TypeScript, `vite-plugin-pwa` (Workbox), Vitest; nginx в Docker отдаёт статическую сборку. Docker / Docker Compose на сервере.

## Структура проекта

```
src/bg_promos/
  cli.py          командная строка (collect / export / stats)
  config.py       загрузка config.ini и .env
  pipeline.py     блокировка, слоты расписания, fetch -> архив -> разбор -> проверка -> запись -> экспорт
  storage.py      схема SQLite и запросы
  export.py       JSON-экспорт, признак stale
  http.py         вежливый HTTP-клиент (пауза, повторы, User-Agent с контактом)
  models.py       Offer / PriceCondition
  sources/        адаптеры lidl.py, kaufland.py, billa.py
  web/            приложение FastAPI: каталог, категории, цены, report (Telegram), config
web/              PWA (React + Vite + TS): src/pages, src/components, src/domain, src/platform,
                  src/content/legal (правовые тексты BG/RU), src/seo, scripts/prerender.mjs,
                  Dockerfile, nginx.conf, pwa-assets.config.ts
tests/            набор pytest с сохранёнными фикстурами
docs/             QUICK_START.md, DEPLOY.md, API.md, MOBILE_STORES.md, SOURCES.md, PROGRESS.md
config.ini        некритичные настройки
.env.example      шаблон переменных окружения
Dockerfile, docker-compose.yml   сервисы: collector (cron), api (:8001), web (:8002)
data/             (в .gitignore) база SQLite, архив сырых ответов, JSON-экспорт
```

## Источники

| Сеть | Источник | Формат | Что используется |
|---|---|---|---|
| Lidl | `https://www.lidl.bg/q/api/search` (JSON API сайта lidl.bg) | JSON, постраничный | товары с реальной акцией или ценой Lidl Plus |
| Kaufland | `https://www.kaufland.bg/aktualni-predlozheniya/oferti.html` | HTML со встроенным JSON `window.SSR` | предложения текущей и следующей недели |
| BILLA | `https://ssbbilla.site/catalog/sedmichna-broshura` и `.../predstoyashta-broshura` | HTML (текстовая версия брошюры) | текущая и будущая брошюра |

Подробности, соответствие полей и риски: [docs/SOURCES.md](docs/SOURCES.md).

## Этап 2: публичный API и PWA

Архитектура:

```
cron хоста --> collector (одноразовый) --> SQLite data/bg_promos.sqlite3 (WAL)
                                                  |  только чтение
браузер --HTTPS--> nginx хоста --> 127.0.0.1:8002  web (nginx: статика PWA + prerender-страницы)
                                                     '-- /api/ --> api:8001 (FastAPI) -----'
                                                           '-- Telegram Bot API (сообщения об ошибках)
браузер --(только после согласия)--> Google Analytics 4
```

Контракт API: [docs/API.md](docs/API.md). Выкатка: [docs/DEPLOY.md](docs/DEPLOY.md). План упаковки в магазины: [docs/MOBILE_STORES.md](docs/MOBILE_STORES.md).

Разработка бэкенда (venv активировано, см. ниже):

```bash
python -m uvicorn bg_promos.web.app:app --port 8001
```

Разработка фронтенда (Node 22; dev-сервер Vite проксирует `/api` на `127.0.0.1:8001`):

```bash
cd web
npm install
npm run dev        # http://localhost:5173
npm test           # Vitest
npm run build      # tsc + vite build + prerender (dist/, sitemap.xml, robots.txt)
npm run preview    # http://localhost:4173 (отдаёт dist/, проксирует /api)
npm run assets     # пересоздать иконки PWA из public/icon.svg (@vite-pwa/assets-generator)
npm run og         # пересоздать public/og-image.png
```

`npm run build` пишет статические HTML-оболочки для `/bg`, `/ru`, `/<lang>/catalog|search|brochures`, `/<lang>/c/<category>` и `/<lang>/legal/<page>` (title, description, canonical, hreflang, Open Graph, JSON-LD на главных), а также `root.html` для `/`, `sitemap.xml` и `robots.txt`. Список категорий для этих страниц: `web/src/seo/categories.json` (должен совпадать с `src/bg_promos/web/categories.py`; это проверяет тест).

Новые разделы `config.ini`:

| Раздел | Ключ | Значение |
|---|---|---|
| web | `site_url` | Публичный адрес сайта (`https://promos.centerai.eu`) |
| web | `cors_origins` | Разрешённые origin через запятую (сайт, `capacitor://localhost`, dev-серверы) |
| web | `ga4_id` | Measurement ID Google Analytics 4 (`G-XXXXXXXXXX`); пусто = аналитика и баннер согласия выключены |
| web | `contact_email`, `operator` | Показываются на правовых страницах и в конфиге API (`info@centerai.eu`, `CenterAI`) |
| web | `report_hourly_per_ip`, `report_daily_per_ip`, `report_daily_global` | Антиспам-лимиты формы сообщений об ошибках |
| web | `trusted_proxies` | Прокси, чьему `X-Forwarded-For` доверяем (IP / CIDR) |
| brochures | `lidl`, `kaufland`, `billa` | Страница брошюры каждой сети (показывается в приложении) |
| offers_urls | `lidl`, `kaufland`, `billa` | Страница акций каждой сети (запасная ссылка «к источнику») |

Новые переменные окружения:

| Переменная | Файл | Значение |
|---|---|---|
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | `.env` | Telegram-бот для сообщений об ошибках; пусто = форма отвечает 503 |
| `VITE_API_BASE` | `web/.env` (шаблон `web/.env.example`) | Абсолютный адрес API для нативных оболочек; пусто = тот же origin |

### Подключение внешних сервисов (этап 2)

- **Telegram Bot API** (сообщения об ошибках): откройте `@BotFather`, отправьте `/newbot`, токен впишите в `TELEGRAM_BOT_TOKEN`. Напишите своему боту, откройте `https://api.telegram.org/bot<TOKEN>/getUpdates` и скопируйте `chat.id` в `TELEGRAM_CHAT_ID`. Документация: https://core.telegram.org/bots/api. Пошагово: [docs/DEPLOY.md](docs/DEPLOY.md).
- **Google Analytics 4** (необязательно, только с согласием): создайте свойство на https://analytics.google.com, добавьте поток Web для `https://promos.centerai.eu`, скопируйте Measurement ID (`G-...`) в `config.ini`, `[web] ga4_id`. Поставьте срок хранения данных 14 месяцев и отключите Google signals. До согласия посетителя ничего от Google не загружается. Документация: https://support.google.com/analytics/answer/9304153.

### Внутренняя аналитика, Microsoft Clarity и `/admin`

Полный контракт: [docs/ANALYTICS.md](docs/ANALYTICS.md). Внутренняя аналитика, Clarity и GA4 запускаются только после единого согласия на аналитику; данные хранятся в `data/analytics.sqlite3`.

`config.ini`, секция `[web]`:

| Ключ | По умолчанию | Значение |
|---|---|---|
| `clarity_id` | пусто | Project ID Microsoft Clarity; пусто = Clarity выключен |
| `analytics_enabled` | `true` | `false` = клиент ничего не отправляет, API аналитики отвечает 404 |
| `admin_cookie_secure` | `true` | На сервере держать `true` (https); `false` только для локального http. Переопределение через окружение: `BG_PROMOS_ADMIN_COOKIE_SECURE=0` |

- **Project ID Clarity**: https://clarity.microsoft.com -> New project (Website `https://promos.centerai.eu`) -> Settings -> Overview -> Project ID. Впишите его в `config.ini` `[web] clarity_id`, затем `docker compose up -d --force-recreate api web`. Документация: https://learn.microsoft.com/clarity/.
- **Формат ссылок кампаний**: бот `https://t.me/promoseubot?start=s_<campaign>[-<placement>]`, Mini App `https://t.me/promoseubot?startapp=s_<campaign>[-<placement>]`, сайт `https://promos.centerai.eu/?utm_source=…&utm_campaign=…`. Ссылки на корзину помечаются автоматически (`share`); сессия без метки наследует последний известный источник посетителя за последние 30 дней (в `/admin` помечается «(унаследован)»). Подробности: [docs/ANALYTICS.md](docs/ANALYTICS.md).
- **Секреты**: задайте `ANALYTICS_SECRET` и `ADMIN_PASSWORD` в `.env` (шаблон: `.env.example`).
- **Админка**: `/admin` (например `https://promos.centerai.eu/admin`; на сайте нет ссылки, `noindex`). Введите `ADMIN_PASSWORD`; сессия длится 12 часов, 5 неверных паролей с одного IP блокируют вход на 15 минут. Локальные шаги: [docs/QUICK_START.md](docs/QUICK_START.md).

## Виртуальное окружение и установка

Windows (Git Bash):

```bash
python -m venv .venv
source .venv/Scripts/activate
```

Windows (PowerShell):

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
```

Linux / macOS:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

Установка (зависимости + пакет в режиме разработки):

```bash
pip install -r requirements-dev.txt && pip install -e .
```

## Конфигурация

Некритичные настройки лежат в `config.ini`; файл ищется так: `--config`, затем `BG_PROMOS_CONFIG`, затем корень проекта.

| Секция | Ключ | По умолчанию | Значение |
|---|---|---|---|
| general | `data_dir` | `data` | Папка данных (относительный путь считается от папки `config.ini`) |
| general | `timezone` | `Europe/Sofia` | Часовой пояс слотов и экспорта |
| general | `contact` | - | Попадает в заголовок `User-Agent` (`BGPromosBot/0.1 (+contact: ...)`) |
| general | `raw_retention_days` | `14` | Сколько хранить сжатые сырые ответы в `data/raw/` |
| http | `timeout` | `30` | Таймаут запроса, секунды |
| http | `delay_seconds` | `1.0` | Пауза между запросами |
| http | `retries` | `3` | Повторы при сетевых ошибках / 5xx |
| http | `backoff_seconds` | `2` | База задержки между повторами |
| schedule | `slots` | `06:30,12:30,18:30` | Локальные (софийские) слоты для `collect --scheduled` |
| completeness | `history_runs` | `5` | Сколько последних хороших запусков берётся для медианы |
| completeness | `min_ratio` | `0.6` | Запуск с числом предложений меньше `min_ratio * медиана` считается «подозрительным» и не сохраняется |
| completeness | `stale_after_hours` | `36` | Экспорт помечает сеть устаревшей, если последний успех старше |
| completeness | `max_retries_per_slot` | `3` | Максимум запусков сети на слот расписания: неудачный запуск повторяется на следующем часовом тике cron (блокировка 403 не повторяется до следующего слота) |
| lidl / kaufland / billa | `enabled` | `true` | Включить/выключить сеть |
| lidl / kaufland / billa | `min_expected_offers` | 50 / 500 / 100 | Жёсткий минимум; меньше - запуск подозрительный |
| lidl | `api_url`, `page_size`, `max_pages` | см. файл | Адрес API и постраничность |
| kaufland | `url` | см. файл | Страница предложений |
| billa | `urls` | см. файл | Страницы брошюр через запятую |

Переменные окружения (`.env`, шаблон в `.env.example`):

| Переменная | Значение |
|---|---|
| `BG_PROMOS_DATA_DIR` | Необязательное переопределение `data_dir` (пусто = брать из `config.ini`) |
| `LOG_LEVEL` | `DEBUG` / `INFO` / `WARNING` / `ERROR` (по умолчанию `INFO`) |
| `BG_PROMOS_CONFIG` | Необязательный путь к `config.ini` (нет в `.env.example`; Docker-образ ставит `/app/config.ini`) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Этап 2: Telegram-бот для сообщений об ошибках (пусто = форма отключена) |
| `PROMOS_BOT_TOKEN` | Публичный бот @promoseubot (пусто = бот отключён, код выхода 0); никогда не совпадает с `TELEGRAM_BOT_TOKEN`; также проверяет initData Mini App для аналитики |
| `ANALYTICS_SECRET` | HMAC-секрет токенов событий аналитики, хеширования анонимного id и cookie `/admin`. Генерация: `python -c "import secrets;print(secrets.token_hex(32))"`. Пусто = случайный на процесс (токены и сессии админки сбрасываются при каждом перезапуске) |
| `ADMIN_PASSWORD` | Пароль `/admin`. Пусто = админка отключена (`/api/admin/*` отвечает 404) |
| `BG_PROMOS_ADMIN_COOKIE_SECURE` | Необязательное переопределение `config.ini [web] admin_cookie_secure` (`0` для локального http); в `.env.example` нет |

```bash
cp .env.example .env
```

## Внешние сервисы и API

API-ключи, аккаунты и платные сервисы не нужны. Сборщики читают публичные страницы/эндпоинты сетей:

- Lidl: `https://www.lidl.bg/q/api/search` - robots.txt lidl.bg разрешает используемые пути. Сайт: https://www.lidl.bg
- Kaufland: `https://www.kaufland.bg/aktualni-predlozheniya/oferti.html` - robots.txt kaufland.bg разрешает. Сайт: https://www.kaufland.bg
- BILLA: `https://ssbbilla.site/catalog/...` - официальная текстовая версия брошюры для слабовидящих. **В её robots.txt стоит `Disallow: /`.** Используется по решению владельца проекта и вежливо: 2 запроса за запуск, пауза 1 с, честный User-Agent с контактом. Блокировки никогда не обходятся: если источник отвечает 403, запуск сети завершается ошибкой, а экспорт помечает сеть как stale.

Все три эндпоинта недокументированы, разметка может измениться; риски описаны в [docs/SOURCES.md](docs/SOURCES.md). Перед публичным использованием данных проверьте условия использования каждой сети.

## Использование CLI

```bash
python -m bg_promos collect                      # все включённые сети + JSON-экспорт
python -m bg_promos collect --chain kaufland     # одна сеть (флаг повторяемый)
python -m bg_promos collect --scheduled          # только сети, для которых наступил слот
python -m bg_promos collect --no-export          # не обновлять JSON
python -m bg_promos collect --accept-suspicious  # сохранить предложения, даже если пороги полноты не пройдены (число > 0)
python -m bg_promos export                       # пересоздать JSON из базы
python -m bg_promos stats                        # последние запуски по сетям
python -m bg_promos --config /path/config.ini stats
```

Коды выхода `collect`: `0` ок/пропуск, `1` сеть упала/подозрительна или упал экспорт, `2` другой запуск держит блокировку (`data/.collect.lock` - файловая блокировка ОС, снимается автоматически при завершении процесса; оставшийся файл безвреден).

## Расписание

На хосте - cron каждый час; `--scheduled` запускает сеть только если с последнего прошедшего слота не было запуска или все запуски с этого слота неудачны (меньше `max_retries_per_slot` запусков, и последняя ошибка - не блокировка 403), поэтому лишние срабатывания cron безвредны, а сбои повторяются:

```
0 * * * * cd /opt/bg-promos && docker compose run --rm -T collector collect --scheduled >> /opt/bg-promos/data/cron.log 2>&1
```

Слоты - **локальное время Europe/Sofia** из `config.ini`, переход на летнее время учтён; часовой пояс хоста значения не имеет.

## Модель данных

Файл SQLite `data/bg_promos.sqlite3`:

| Таблица | Назначение |
|---|---|
| `scrape_runs` | Строка на запуск сети: статус (`running/ok/suspicious/failed`), число предложений, `content_hash`, `content_changed`, ошибка |
| `products` | Товар внутри сети, ключ `(chain, product_ref)` |
| `offers` | Предложение товара на период действия, ключ `(chain, source_key, valid_from, valid_to)` |
| `offer_prices` | Ценовые условия предложения |
| `price_observations` | История: строка добавляется, когда условие появилось или цена изменилась |

`product_ref` по сетям: Lidl - id товара; Kaufland - `klNr` (артикул); BILLA - хэш нормализованного названия (в источнике только свободный текст).

Виды цен (`offer_prices.kind`), деньги в **целых центах EUR**:

- `regular` - базовая (до акции) цена;
- `promo` - акционная цена для всех;
- `loyalty` - цена по программе лояльности (`lidl_plus`, `kaufland_card`, `billa_card`, `billa_app`);
- `multibuy` - цена при покупке `min_qty` штук вместе (1+1, 2+1).

`price_cents` - сумма за `min_qty` штук (для цены за штуку делите на `min_qty`). Для акции Kaufland «1+1»: `multibuy`, `min_qty=2`, `price_cents` = итог за 2 штуки, плюс `regular` = старая сумма / 2.

## Полнота и признак stale

- Запуск с числом предложений меньше `min_expected_offers` или меньше `min_ratio` x медиана последних хороших запусков считается `suspicious`: он не сохраняется, прежние хорошие данные остаются.
- Обе проверки считают только предложения, **активные на дату запуска** (Europe/Sofia; `valid_from <= день <= valid_to`, отсутствующие даты считаются активными), и сравнивают с таким же числом последних хороших запусков, поэтому предложения следующей недели, которые сеть публикует в конце недели (Kaufland), не искажают соотношение.
- Подозрительный результат остаётся подозрительным: автоматического принятия новой базовой линии нет. Экспорт сохраняет последние хорошие данные с пометкой `stale`; новую базовую линию владелец принимает вручную через `collect --accept-suspicious` (сохраняет офферы несмотря на непройденные пороги, только если найден хотя бы один оффер).
- Сохранение офферов запуска и пометка запуска `ok` выполняются в одной транзакции; при любой ошибке всё откатывается, запуск помечается `failed`, предыдущий снимок остаётся нетронутым.
- Экспорт всегда берёт **последний успешный запуск** каждой сети.
- Сеть помечается `stale` в экспорте, если успехов не было, последний успех старше `stale_after_hours` или последний запуск не `ok` (причина в `stale_reason`).
- Истёкшие предложения (`valid_to` раньше сегодняшней даты по Софии) в экспорт не попадают; начинающиеся позже уходят в `upcoming`.
- Сырые ответы архивируются в `data/raw/<chain>/*.gz` и удаляются через `raw_retention_days`.

## JSON-экспорт

Пишется атомарно в `data/export/`: `offers_current.json`, `offers_upcoming.json`, `lidl.json`, `kaufland.json`, `billa.json`.

```json
{
  "meta": {
    "generated_at": "2026-10-17T15:42:02+03:00",
    "currency": "EUR",
    "timezone": "Europe/Sofia",
    "bgn_rate": 1.95583,
    "chains": {
      "kaufland": {
        "status": "ok", "last_run_at": "...", "last_success_at": "...",
        "stale": false, "stale_reason": null,
        "offers_current": 1012, "offers_upcoming": 1067,
        "valid_from_min": "2026-10-12", "valid_to_max": "2026-10-25"
      }
    }
  },
  "offers": [
    {
      "chain": "kaufland", "product_ref": "00057181", "source_key": "...",
      "name": "Atani Червен пипер сладък", "brand": null, "description": "...",
      "category": "...", "unit_text": "200 г", "offer_label": null,
      "valid_from": "2026-10-12", "valid_to": "2026-10-18",
      "image_url": "https://...", "product_url": null,
      "prices": [
        {"kind": "regular", "program": null, "min_qty": 1, "price_cents": 189, "discount_pct": null, "condition_text": null},
        {"kind": "multibuy", "program": "kaufland_card", "min_qty": 2, "price_cents": 189, "discount_pct": 50, "condition_text": "ВЗЕМИ 1+1 БЕЗПЛАТНО KAUFLAND CARD XTRA"}
      ],
      "price_cents": null, "regular_price_cents": 189,
      "discount_pct": null, "loyalty_price_cents": null, "loyalty_program": null,
      "best_price": {"kind": "multibuy", "program": "kaufland_card", "min_qty": 2, "price_cents": 189, "unit_price_cents": 95, "discount_pct": 50}
    }
  ]
}
```

Плоские поля - сокращения: `price_cents` и `discount_pct` - только **акционная** (promo) цена и скидка (`null`, если promo-условия нет), а также `regular_price_cents` и `loyalty_*`. `best_price` - самое дешёвое условие в пересчёте на штуку среди promo/loyalty/multibuy (`unit_price_cents` = `price_cents / min_qty`, округлено); если их нет, но есть regular - строится из regular; иначе `null`. Полную картину смотрите в списке `prices`.

## Telegram-бот (@promoseubot)

Публичный бот на aiogram 3 (long polling, без вебхука и Nginx): `/start`, `/app`, `/install`, `/help`, открывает Mini App и показывает инструкции по установке PWA. Нужны `PROMOS_BOT_TOKEN` в `.env` (токен из @BotFather; это не технический `TELEGRAM_BOT_TOKEN`) и `[bot] webapp_url` в `config.ini`. Запуск: `python -m bg_promos.bot` локально или `docker compose build bot && docker compose up -d bot` на VPS. На один токен допускается только один экземпляр с polling. Подробности: [docs/BOT.md](docs/BOT.md).

## Тесты

```bash
pytest -q                          # бэкенд (сборщики, API)
cd web && npm test                 # фронтенд (Vitest)
```

## Docker и развёртывание (VPS, Ubuntu + Docker Compose)

Docker и Docker Compose считаются уже установленными.

```bash
cd /opt
git clone <repository-url> bg-promos
cd /opt/bg-promos
cp .env.example .env
mkdir -p data && sudo chown 1000:1000 data
docker compose build
docker compose run --rm collector collect
docker compose run --rm collector stats
crontab -e   # добавить строку из раздела «Расписание»
```

`<repository-url>` - адрес вашего git-репозитория с этим проектом. Образ работает от пользователя `app` (uid 1000), `config.ini` и `data/` монтируются с хоста (`data_dir` разрешается в `/app/data`). Проверка: `stats` показывает `last run: ok` по всем сетям, а файл `data/export/offers_current.json` существует. Обновление: `git pull && docker compose build`.

Сервисы этапа 2 (`api` на `127.0.0.1:8001`, `web` на `127.0.0.1:8002`) запускаются отдельно и не затрагивают collector и cron:

```bash
docker compose build api web && docker compose up -d api web
curl -s http://127.0.0.1:8001/api/health
curl -I http://127.0.0.1:8002/
```

Nginx хоста для `promos.centerai.eu` проксирует всё на `127.0.0.1:8002`; полная процедура (проверка портов, Telegram, GA4, nginx, сертификат) в [docs/DEPLOY.md](docs/DEPLOY.md).

Правовые тексты в `web/src/content/legal/` являются шаблоном, а не юридической консультацией.
