# BG Promos

Сборщики актуальных акционных предложений болгарских торговых сетей **Lidl**, **Kaufland** и **BILLA**.
Предложения разбираются в единую модель, сохраняются в SQLite (с историей цен) и выгружаются в JSON-файлы.

Документация: [Быстрый старт](docs/QUICK_START.md) | [Исследование источников](docs/SOURCES.md) | [Прогресс](docs/PROGRESS.md) | [English README](README.md)

## Охват

- **Этап 1 (готов):** сборщики для трёх сетей -> SQLite -> JSON-экспорт; запуск по расписанию; проверки полноты; признак устаревших данных.
- **Будущие этапы (не начаты):** сопоставление одного товара между сетями, сравнение цен, пользовательский сервис поверх JSON/SQLite.

## Стек

Python 3.12+, `httpx` (HTTP), `beautifulsoup4` (HTML), `python-dotenv`, `tzdata`, SQLite (stdlib), `pytest`. Docker / Docker Compose на сервере.

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
tests/            набор pytest с сохранёнными фикстурами
docs/             QUICK_START.md, SOURCES.md, PROGRESS.md
config.ini        некритичные настройки
.env.example      шаблон переменных окружения
Dockerfile, docker-compose.yml
data/             (в .gitignore) база SQLite, архив сырых ответов, JSON-экспорт
```

## Источники

| Сеть | Источник | Формат | Что используется |
|---|---|---|---|
| Lidl | `https://www.lidl.bg/q/api/search` (JSON API сайта lidl.bg) | JSON, постраничный | товары с реальной акцией или ценой Lidl Plus |
| Kaufland | `https://www.kaufland.bg/aktualni-predlozheniya/oferti.html` | HTML со встроенным JSON `window.SSR` | предложения текущей и следующей недели |
| BILLA | `https://ssbbilla.site/catalog/sedmichna-broshura` и `.../predstoyashta-broshura` | HTML (текстовая версия брошюры) | текущая и будущая брошюра |

Подробности, соответствие полей и риски: [docs/SOURCES.md](docs/SOURCES.md).

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
- Восстановление базовой линии: если запуск не проходит только правило `min_ratio`, а последние 2 завершённых запуска оба `suspicious` с числом в пределах +-10 % от текущего, новый уровень принимается как `ok` (предупреждение «accepting new baseline»). `collect --accept-suspicious` принудительно сохраняет данные при непройденных порогах.
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

## Тесты

```bash
pytest -q
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
