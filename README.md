# BG Promos

Collectors of current promo offers of the Bulgarian retail chains **Lidl**, **Kaufland** and **BILLA**.
Offers are parsed into a normalized model, stored in SQLite (with price history) and exported as JSON files.

Documentation: [Quick start (RU)](docs/QUICK_START.md) | [Deploy (RU)](docs/DEPLOY.md) | [API](docs/API.md) | [Mobile stores (RU)](docs/MOBILE_STORES.md) | [Sources research (RU)](docs/SOURCES.md) | [Progress (RU)](docs/PROGRESS.md) | [Русская версия README](README_RU.md)

## Scope

- **Stage 1 (done):** collectors for three chains -> SQLite -> JSON export; scheduled runs; completeness checks; stale flags.
- **Stage 2 (done, rollout pending):** public read-only API (FastAPI) and a mobile-first PWA (React + Vite + TypeScript) at `https://promos.centerai.eu`: catalog, search, filters, category landing pages, brochures, bilingual (BG/RU) legal pages, error report form (Telegram), optional Google Analytics 4 with consent, build-time prerender for SEO.
- **Future stages (not started):** matching the same product across chains, price comparison, notifications, store packaging ([docs/MOBILE_STORES.md](docs/MOBILE_STORES.md)).

## Stack

Python 3.12+, `httpx` (HTTP), `beautifulsoup4` (HTML), `python-dotenv`, `tzdata`, SQLite (stdlib, WAL), `pytest`. API: FastAPI + uvicorn. Frontend: React 18, Vite 5, TypeScript, `vite-plugin-pwa` (Workbox), Vitest; nginx in Docker serves the static build. Docker / Docker Compose for the server.

## Project structure

```
src/bg_promos/
  cli.py          command line (collect / export / stats)
  config.py       config.ini + .env loading
  pipeline.py     lock, schedule slots, fetch -> archive -> parse -> validate -> store -> export
  storage.py      SQLite schema and queries
  export.py       JSON export, stale flags
  http.py         polite HTTP client (delay, retries, User-Agent with contact)
  models.py       Offer / PriceCondition
  sources/        lidl.py, kaufland.py, billa.py adapters
  web/            FastAPI app: catalog, categories, pricing, report (Telegram), config
web/              PWA (React + Vite + TS): src/pages, src/components, src/domain, src/platform,
                  src/content/legal (BG/RU legal texts), src/seo, scripts/prerender.mjs,
                  Dockerfile, nginx.conf, pwa-assets.config.ts
tests/            pytest suite with saved fixtures
docs/             QUICK_START.md, DEPLOY.md, API.md, MOBILE_STORES.md, SOURCES.md, PROGRESS.md
config.ini        non-secret settings
.env.example      environment template
Dockerfile, docker-compose.yml   services: collector (cron), api (:8001), web (:8002)
data/             (git-ignored) SQLite db, raw archive, JSON export
```

## Sources

| Chain | Source | Format | Used |
|---|---|---|---|
| Lidl | `https://www.lidl.bg/q/api/search` (the JSON API behind lidl.bg) | JSON, paginated | items with a real promotion or a Lidl Plus price |
| Kaufland | `https://www.kaufland.bg/aktualni-predlozheniya/oferti.html` | HTML with embedded `window.SSR` JSON | current and next week offers |
| BILLA | `https://ssbbilla.site/catalog/sedmichna-broshura` and `.../predstoyashta-broshura` | HTML (text version of the brochure) | current and upcoming brochure |

Details, field mapping and risks: [docs/SOURCES.md](docs/SOURCES.md).

## Stage 2: public API and PWA

Architecture:

```
host cron --> collector (one-shot) --> SQLite data/bg_promos.sqlite3 (WAL)
                                              |  read-only
browser --HTTPS--> host nginx --> 127.0.0.1:8002  web (nginx: static PWA + prerendered pages)
                                                    '-- /api/ --> api:8001 (FastAPI) -----'
                                                          '-- Telegram Bot API (error reports)
browser --(only after consent)--> Google Analytics 4
```

API contract: [docs/API.md](docs/API.md). Deployment: [docs/DEPLOY.md](docs/DEPLOY.md). Store packaging plan: [docs/MOBILE_STORES.md](docs/MOBILE_STORES.md).

Backend development (venv activated, see below):

```bash
python -m uvicorn bg_promos.web.app:app --port 8001
```

Frontend development (Node 22; the Vite dev server proxies `/api` to `127.0.0.1:8001`):

```bash
cd web
npm install
npm run dev        # http://localhost:5173
npm test           # Vitest
npm run build      # tsc + vite build + prerender (dist/, sitemap.xml, robots.txt)
npm run preview    # http://localhost:4173 (serves dist/, proxies /api)
npm run assets     # regenerate PWA icons from public/icon.svg (@vite-pwa/assets-generator)
npm run og         # regenerate public/og-image.png
```

`npm run build` writes static HTML shells for `/bg`, `/ru`, `/<lang>/catalog|search|brochures`, `/<lang>/c/<category>` and `/<lang>/legal/<page>` (title, description, canonical, hreflang, Open Graph, JSON-LD on home pages), plus `root.html` for `/`, `sitemap.xml` and `robots.txt`. The category list for these pages is `web/src/seo/categories.json` (must match `src/bg_promos/web/categories.py`; a test checks it).

New `config.ini` sections:

| Section | Key | Meaning |
|---|---|---|
| web | `site_url` | Public site URL (`https://promos.centerai.eu`) |
| web | `cors_origins` | Comma-separated allowed origins (site, `capacitor://localhost`, dev servers) |
| web | `ga4_id` | Google Analytics 4 Measurement ID (`G-XXXXXXXXXX`); empty = analytics and the consent banner are off |
| web | `contact_email`, `operator` | Shown in legal pages and the API config (`info@centerai.eu`, `CenterAI`) |
| web | `report_hourly_per_ip`, `report_daily_per_ip`, `report_daily_global` | Anti-spam limits of the error report form |
| web | `trusted_proxies` | Proxies whose `X-Forwarded-For` is trusted (IPs / CIDR) |
| brochures | `lidl`, `kaufland`, `billa` | Brochure page of each chain (shown in the app) |
| offers_urls | `lidl`, `kaufland`, `billa` | Offers page of each chain (fallback "to the source" link) |

New environment variables:

| Variable | File | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | `.env` | Telegram bot for error reports; empty = the report form answers 503 |
| `VITE_API_BASE` | `web/.env` (template `web/.env.example`) | Absolute API base for native shells; empty = same origin |

### Connecting external services (stage 2)

- **Telegram Bot API** (error reports): open `@BotFather`, send `/newbot`, copy the token into `TELEGRAM_BOT_TOKEN`. Write to your bot, open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id` into `TELEGRAM_CHAT_ID`. Docs: https://core.telegram.org/bots/api. Step by step: [docs/DEPLOY.md](docs/DEPLOY.md).
- **Google Analytics 4** (optional, consent only): create a property at https://analytics.google.com, add a Web data stream for `https://promos.centerai.eu`, copy the Measurement ID (`G-...`) into `config.ini` `[web] ga4_id`. Set data retention to 14 months and turn Google signals off. Nothing from Google is loaded before the visitor accepts. Docs: https://support.google.com/analytics/answer/9304153.

### Internal analytics, Microsoft Clarity and `/admin`

Full contract: [docs/ANALYTICS.md](docs/ANALYTICS.md). Internal analytics, Clarity and GA4 start only after the single analytics consent; the data is stored in `data/analytics.sqlite3`.

`config.ini` section `[web]`:

| Key | Default | Meaning |
|---|---|---|
| `clarity_id` | empty | Microsoft Clarity Project ID; empty = Clarity off |
| `analytics_enabled` | `true` | `false` = the client sends nothing and the analytics API answers 404 |
| `admin_cookie_secure` | `true` | Keep `true` on the server (https); `false` only for local http. Env override: `BG_PROMOS_ADMIN_COOKIE_SECURE=0` |

- **Clarity Project ID**: https://clarity.microsoft.com -> New project (Website `https://promos.centerai.eu`) -> Settings -> Overview -> Project ID. Put it into `config.ini` `[web] clarity_id`, then `docker compose up -d --force-recreate api web`. Docs: https://learn.microsoft.com/clarity/.
- **Campaign link format**: bot `https://t.me/promoseubot?start=s_<campaign>[-<placement>]`, Mini App `https://t.me/promoseubot?startapp=s_<campaign>[-<placement>]`, site `https://promos.centerai.eu/?utm_source=…&utm_campaign=…`. Shared carts are tagged automatically (`share`); a session without a label inherits the visitor's last known source from the last 30 days (marked "(унаследован)" in `/admin`). Details: [docs/ANALYTICS.md](docs/ANALYTICS.md).
- **Secrets**: set `ANALYTICS_SECRET` and `ADMIN_PASSWORD` in `.env` (template: `.env.example`).
- **Admin page**: `/admin` (for example `https://promos.centerai.eu/admin`; not linked from the site, `noindex`). Enter `ADMIN_PASSWORD`; the session lasts 12 hours, 5 wrong passwords per IP lock the login for 15 minutes. Local steps: [docs/QUICK_START.md](docs/QUICK_START.md).

## Virtual environment and installation

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

Install (dependencies + the package in editable mode):

```bash
pip install -r requirements-dev.txt && pip install -e .
```

## Configuration

Non-secret settings live in `config.ini`; the file is looked up at `--config`, then `BG_PROMOS_CONFIG`, then the project root.

| Section | Key | Default | Meaning |
|---|---|---|---|
| general | `data_dir` | `data` | Data folder (relative paths are resolved against the folder of `config.ini`) |
| general | `timezone` | `Europe/Sofia` | Time zone of slots and of the export |
| general | `contact` | - | Put in the `User-Agent` header (`BGPromosBot/0.1 (+contact: ...)`) |
| general | `raw_retention_days` | `14` | How long gzipped raw responses are kept in `data/raw/` |
| http | `timeout` | `30` | Request timeout, seconds |
| http | `delay_seconds` | `1.0` | Pause between requests |
| http | `retries` | `3` | Retries on network errors / 5xx |
| http | `backoff_seconds` | `2` | Base of the retry back-off |
| schedule | `slots` | `06:30,12:30,18:30` | Local (Sofia) slots for `collect --scheduled` |
| completeness | `history_runs` | `5` | How many last good runs form the median |
| completeness | `min_ratio` | `0.6` | A run with fewer offers than `min_ratio * median` is "suspicious" and not saved |
| completeness | `stale_after_hours` | `36` | Export marks a chain stale if the last success is older |
| completeness | `max_retries_per_slot` | `3` | Max runs of a chain per schedule slot: a failed run is retried on the next hourly cron tick (a 403 block is not retried until the next slot) |
| lidl / kaufland / billa | `enabled` | `true` | Switch a chain on/off |
| lidl / kaufland / billa | `min_expected_offers` | 50 / 500 / 100 | Hard minimum; fewer offers = suspicious run |
| lidl | `api_url`, `page_size`, `max_pages` | see file | API address and paging |
| kaufland | `url` | see file | Offers page |
| billa | `urls` | see file | Comma-separated brochure pages |

Environment variables (`.env`, template in `.env.example`):

| Variable | Meaning |
|---|---|
| `BG_PROMOS_DATA_DIR` | Optional override of `data_dir` (empty = use `config.ini`) |
| `LOG_LEVEL` | `DEBUG` / `INFO` / `WARNING` / `ERROR` (default `INFO`) |
| `BG_PROMOS_CONFIG` | Optional path to `config.ini` (not in `.env.example`; set by the Docker image to `/app/config.ini`) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Stage 2: Telegram bot for error reports (empty = form disabled) |
| `PROMOS_BOT_TOKEN` | Public bot @promoseubot (empty = bot disabled, exit 0); never the same as `TELEGRAM_BOT_TOKEN`; also verifies Mini App initData for analytics |
| `ANALYTICS_SECRET` | HMAC secret of analytics event tokens, anonymous-id hashing and the `/admin` cookie. Generate: `python -c "import secrets;print(secrets.token_hex(32))"`. Empty = random per process (tokens and admin sessions reset on every restart) |
| `ADMIN_PASSWORD` | Password of `/admin`. Empty = admin disabled (`/api/admin/*` answers 404) |
| `BG_PROMOS_ADMIN_COOKIE_SECURE` | Optional override of `config.ini [web] admin_cookie_secure` (`0` for local http); not in `.env.example` |

```bash
cp .env.example .env
```

## External services and API

No API keys, accounts or paid services are needed. The collectors read public pages/endpoints of the chains:

- Lidl: `https://www.lidl.bg/q/api/search` - robots.txt of lidl.bg allows the used paths. Site: https://www.lidl.bg
- Kaufland: `https://www.kaufland.bg/aktualni-predlozheniya/oferti.html` - robots.txt of kaufland.bg allows it. Site: https://www.kaufland.bg
- BILLA: `https://ssbbilla.site/catalog/...` - the official text version of the brochure for visually impaired users. **Its robots.txt is `Disallow: /`.** It is used by the project owner's decision, politely: 2 requests per run, 1 s delay, an honest User-Agent with a contact. Blocks are never bypassed: if a source answers 403 the chain run fails, and the export marks the chain as stale.

All three endpoints are undocumented, so their markup may change; see the risks in [docs/SOURCES.md](docs/SOURCES.md). Check the terms of use of each chain before any public reuse of the data.

## CLI usage

```bash
python -m bg_promos collect                      # all enabled chains + JSON export
python -m bg_promos collect --chain kaufland     # one chain (repeatable)
python -m bg_promos collect --scheduled          # only chains that are due in the current slot
python -m bg_promos collect --no-export          # do not refresh the JSON files
python -m bg_promos collect --accept-suspicious  # save offers even if completeness thresholds fail (count > 0)
python -m bg_promos export                       # regenerate JSON from the database
python -m bg_promos stats                        # last runs per chain
python -m bg_promos --config /path/config.ini stats
```

Exit codes of `collect`: `0` ok/skipped, `1` a chain failed/suspicious or export failed, `2` another run holds the lock (`data/.collect.lock`, an OS file lock that is released automatically when the process dies; a leftover file is harmless).

## Scheduling

On the host, hourly cron; `--scheduled` runs a chain only if no run of it started after the last passed slot, or if every run since the slot failed (fewer than `max_retries_per_slot` runs, and the last failure was not a 403 block), so extra cron ticks are harmless and failures are retried:

```
0 * * * * cd /opt/bg-promos && docker compose run --rm -T collector collect --scheduled >> /opt/bg-promos/data/cron.log 2>&1
```

Slots are **local Europe/Sofia times** from `config.ini`, DST-safe; the time zone of the host is irrelevant.

## Data model

SQLite file `data/bg_promos.sqlite3`:

| Table | Purpose |
|---|---|
| `scrape_runs` | One row per chain run: status (`running/ok/suspicious/failed`), offers count, `content_hash`, `content_changed`, error |
| `products` | A product inside a chain, key `(chain, product_ref)` |
| `offers` | An offer of a product for a validity period, key `(chain, source_key, valid_from, valid_to)` |
| `offer_prices` | Price conditions of an offer |
| `price_observations` | History: a row is added when a condition appears or its price changes |

`product_ref` per chain: Lidl - product id; Kaufland - `klNr` (article number); BILLA - hash of the normalized name (the source has only free text).

Price conditions (`offer_prices.kind`), money in **integer EUR cents**:

- `regular` - reference (pre-promo) price;
- `promo` - offer price for everyone;
- `loyalty` - price with a loyalty program (`lidl_plus`, `kaufland_card`, `billa_card`, `billa_app`);
- `multibuy` - price for buying `min_qty` units together (1+1, 2+1).

`price_cents` is the amount for `min_qty` units (divide by `min_qty` for a unit price). For a Kaufland "1+1" deal: `multibuy`, `min_qty=2`, `price_cents` = total for 2 units, plus `regular` = old total / 2.

## Completeness and stale logic

- A run with fewer offers than `min_expected_offers`, or fewer than `min_ratio` x the median of the last good runs, is `suspicious`: it is not saved and the previous good data stays.
- A suspicious result stays suspicious: there is no automatic acceptance of a new baseline. The export keeps the last good data marked `stale`; the owner accepts a new baseline manually with `collect --accept-suspicious` (saves the offers despite failed thresholds, only if at least one offer was found).
- Saving a run's offers and marking the run `ok` happen in one transaction; on any failure everything is rolled back, the run is marked `failed` and the previous snapshot stays intact.
- The export always uses the **last successful run** of each chain.
- A chain is `stale` in the export when it never succeeded, the last success is older than `stale_after_hours`, or the last run was not `ok` (with `stale_reason`).
- Expired offers (`valid_to` before today, Sofia time) are dropped from the export; offers starting later go to `upcoming`.
- Raw responses are archived as `data/raw/<chain>/*.gz` and removed after `raw_retention_days`.

## JSON export

Written atomically to `data/export/`: `offers_current.json`, `offers_upcoming.json`, `lidl.json`, `kaufland.json`, `billa.json`.

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

The flat fields are shortcuts: `price_cents` and `discount_pct` are the **promo** price/discount only (`null` if there is no promo condition), plus `regular_price_cents` and `loyalty_*`. `best_price` is the cheapest per-unit condition among promo/loyalty/multibuy (`unit_price_cents` = `price_cents / min_qty`, rounded); if the offer has none of them but has a regular price, it is built from the regular price; otherwise `null`. For full detail read the `prices` list.

## Telegram bot (@promoseubot)

Public bot on aiogram 3 (long polling, no webhook/Nginx): `/start`, `/app`, `/install`, `/help`, opens the Mini App and shows PWA install instructions. Needs `PROMOS_BOT_TOKEN` in `.env` (token from @BotFather; not the technical `TELEGRAM_BOT_TOKEN`) and `[bot] webapp_url` in `config.ini`. Run: `python -m bg_promos.bot` locally or `docker compose build bot && docker compose up -d bot` on the VPS. Only one polling instance per token. Details: [docs/BOT.md](docs/BOT.md).

## Tests

```bash
pytest -q                          # backend (collectors, API)
cd web && npm test                 # frontend (Vitest)
```

## Docker and deployment (VPS, Ubuntu + Docker Compose)

Docker and Docker Compose are expected to be installed already.

```bash
cd /opt
git clone <repository-url> bg-promos
cd /opt/bg-promos
cp .env.example .env
mkdir -p data && sudo chown 1000:1000 data
docker compose build
docker compose run --rm collector collect
docker compose run --rm collector stats
crontab -e   # add the line from the "Scheduling" section
```

`<repository-url>` is the address of your own git repository with this project. The image runs as user `app` (uid 1000), `config.ini` and `data/` are mounted from the host (`data_dir` resolves to `/app/data`). Verification: `stats` shows `last run: ok` for all chains and `data/export/offers_current.json` exists. Update: `git pull && docker compose build`.

Stage 2 services (`api` on `127.0.0.1:8001`, `web` on `127.0.0.1:8002`) are started separately and never touch the collector or cron:

```bash
docker compose build api web && docker compose up -d api web
curl -s http://127.0.0.1:8001/api/health
curl -I http://127.0.0.1:8002/
```

The host nginx for `promos.centerai.eu` proxies everything to `127.0.0.1:8002`; the full procedure (ports check, Telegram, GA4, nginx, certificate) is in [docs/DEPLOY.md](docs/DEPLOY.md).

The legal texts in `web/src/content/legal/` are a template, not legal advice.
