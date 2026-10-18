# BG Promos — internal analytics, Clarity, /admin (contract)

Owner decisions: see CLAUDE.md "## Project rules" (2026-10-18). This file is the contract
for backend, frontend and tests.

## Principles
- Internal analytics, Clarity and GA4 start **only after the single analytics consent**
  (existing consent store, `prefs` key `consent`; one banner; changeable on the Cookies page).
  Refusal or no answer → no analytics requests at all (no session, no events, no Clarity).
- Technical data (cart in localStorage, bot replies) never depends on consent and is never
  sent as analytics.
- Telegram identity only from **server-verified initData** (`bg_promos.analytics.telegram.
  verify_init_data`, HMAC with `PROMOS_BOT_TOKEN`). `initDataUnsafe`, client-sent Telegram ids
  and raw initData are never trusted, stored or logged.
- Site visitors: random anonymous id (`crypto.randomUUID`), created only after consent,
  stored in localStorage `bgpromos:aid`. No fingerprinting, no IP linking, no site↔Telegram
  linking.
- Analytics never blocks or breaks the app: fire-and-forget, batched, failures swallowed.

## Storage — `data/analytics.sqlite3` (separate file, WAL, written by api and bot)
```
sources(id PK, kind, source, medium, campaign, placement, UNIQUE(kind,source,medium,campaign,placement))
visitors(id TEXT PK            -- opaque internal id ("v_" + 20 hex), also used for Clarity identify
         kind TEXT             -- 'tg' | 'anon'
         tg_id INTEGER UNIQUE NULL, username, first_name, last_name, language,
         anon_key TEXT UNIQUE NULL  -- sha256(client anonymous id) for site visitors
         first_seen, last_seen, first_source_id FK, is_test INT DEFAULT 0)
sessions(id TEXT PK (client uuid), visitor_id FK, platform 'web'|'miniapp'|'bot',
         started_at, last_at, source_id FK, lang, is_automated INT, is_test INT)
events(id PK, event_id TEXT UNIQUE   -- client uuid → idempotent re-sends
       visitor_id, session_id, ts, name, platform, props JSON)
```
Indexes on events(ts), events(name, ts), events(visitor_id, ts), sessions(started_at).
Retention (owner): events older than 13 months are deleted daily by the api process;
visitors are kept until deleted manually in /admin (deletes the visitor, sessions, events).

## Events (name → props; anything else is rejected)
| name | where | props |
|---|---|---|
| `bot_start` | bot, server-side | `{payload_kind: "none"|"label"|"other"}` |
| `site_open` | web, session start | `{}` |
| `miniapp_open` | Mini App, session start | `{}` |
| `catalog_loaded` | after the catalog is shown | `{offers:int, from_cache:bool}` |
| `offer_view` | offer page | `{offer_id, chain, category}` |
| `search` | committed search | `{len:int, results:int, query?: str}` — `query` (normalised, ≤60 chars) ONLY when results = 0 |
| `filter_apply` | filters applied | `{keys:[str]}` (names of changed filters only) |
| `cart_add` / `cart_remove` | cart | `{offer_id, chain, category}` |
| `cart_qty` | qty/weight change | `{offer_id, chain, delta:int, unit:"piece"|"g"}` |
| `card_toggle` | loyalty switch | `{chain, on:bool}` |
| `share_link_created` | share panel opened with links | `{lines:int, telegram:bool}` |
| `share_copy` | copy button | `{block:"tg"|"web", ok:bool}` |
| `cart_import` | import finished | `{mode, added:int, missing:int}` (count only `filled`/`created` as successful) |
| `app_error` | ErrorBoundary / window error | `{name: str ≤60, where: str ≤60}` — no messages, no stack |
Never: names, usernames, Telegram ids, list contents, prices of a user's list, free text
(except the zero-result `query` above, internal only, never sent to Clarity/GA4).
"Создание ссылки" ≠ "отправка"; "открытие приложения" ≠ "каталог загружен".

## API
- `POST /api/v1/analytics/session` `{session_id, anon_id?|init_data?, platform, lang, utm{…}, referrer?, start_param?, test?}`
  → verifies initData (Mini App) or hashes anon_id (web); resolves the session source
  (`attribution.py`), upserts visitor (first_source kept), creates the session (idempotent on
  session_id), records `site_open`/`miniapp_open`; returns `{token, visitor_id}` where token =
  HMAC(ANALYTICS_SECRET, session_id|visitor_id) for event batches.
- `POST /api/v1/analytics/events` `{token, session_id, events:[{event_id, name, ts, props}]}`
  ≤ 50 events, body ≤ 32 KB, per-session and per-IP rate limits; unknown names/props → 400 for
  that event (others accepted); duplicate event_id ignored (INSERT OR IGNORE).
- Automated/test traffic: user agents matching headless/Lighthouse/bots/TelegramBot link
  preview → `is_automated`; `test` flag (?bgtest=1 remembered locally) → `is_test`. Both are
  excluded from main metrics by default (toggle in /admin).
- Admin (`/api/admin/*`, only with the admin session cookie): login/logout, metrics, users,
  user card, delete user. ADMIN_PASSWORD in .env (empty = admin disabled); cookie
  `bgp_admin` = signed (ANALYTICS_SECRET) expiry, HttpOnly, Secure, SameSite=Strict, 12 h;
  login rate limit 5/15 min per IP (attempt reserved atomically before the password check; a
  successful login clears that IP's failures); constant-time compare; tokens/cookie MACs are
  validated as ASCII hex before comparison (invalid -> 401, never 500).
  User search is `POST /api/admin/users/search` (JSON body: `q`, `from`, `to`, filters, `limit`,
  `offset`): personal search text never goes into URLs; `GET /api/admin/users` has no `q`. The
  uvicorn access log drops query strings of `/api/admin/*`.
- Schema v2: `sessions.visitor_id`, `events.visitor_id`, `events.session_id` are foreign keys
  `ON DELETE CASCADE` (`PRAGMA foreign_keys=ON` on every connection). Event inserts re-check the
  session/visitor inside the same write transaction (deleted meanwhile -> 401, nothing written).
- Bot `/start`: session and event ids are uuid5 of the Telegram update (`update_id`, else chat +
  message id), so a redelivered update changes nothing.

## Metrics (period [from, to] Sofia dates; filters platform, lang, source kind/source, campaign)
- users = distinct visitors with a session in the period; tg users and anonymous separately
- sessions; bot starts (`bot_start`); Mini App opens (`miniapp_open`); site opens (`site_open`)
- catalog loads (`catalog_loaded`)
- users who added to cart (distinct visitors with `cart_add`)
- share links created; successful imports (`cart_import` with mode filled|created)
- returning visitors = visitors with sessions on ≥ 2 different Sofia days (ever, active in period)
- top offers (by `offer_view` and by `cart_add`), zero-result queries (count by query), errors
  (`app_error` by name/where)
- Never present cart sums as revenue or purchases.

## Clarity
`config.ini [web] clarity_id` (empty = disabled) → `/api/v1/config.clarity_id`. Loaded once
(guard) only after consent; consent passed via `clarity('consentv2', {ad_Storage:'denied',
analytics_Storage:'granted'})`; revoke → `clarity('consentv2', {…:'denied'})` and stop.
Tags: `lang`, `platform` (web|miniapp), `source_kind`, `campaign`. Events: `catalog_loaded`,
`cart_add`, `share_link_created`, `cart_import`. `clarity('identify', visitor_id)` with the
opaque id only. Personal UI (cart lines, list names, admin) masked with `data-clarity-mask`.
SPA route changes do not re-initialise Clarity. Consent withdrawal, or entering `/admin` while Clarity
runs in the page, calls `clarity('consent', false)` + `consentv2` denied and hard-reloads the page
(the recorder cannot be unloaded). `/admin` otherwise only pauses the internal client
(`suspendInsights`: anonymous id and session kept); `revokeInsights` (clears id/queue/session) is
for consent withdrawal only. The committed search text lives in router state, not in the URL
(`?q=` on entry is moved to state and stripped); the search area is `data-clarity-mask`.

## Operations
- **Env (`.env`)**: `ANALYTICS_SECRET` (HMAC secret for event tokens, anonymous-id hashing and the admin
  cookie; generate with `python -c "import secrets;print(secrets.token_hex(32))"`; empty = random per process,
  warning in the log, tokens and admin sessions reset on every restart) and `ADMIN_PASSWORD` (empty = `/admin`
  disabled, `/api/admin/*` answers 404). `PROMOS_BOT_TOKEN` is also used to verify Mini App initData.
  Changing `ANALYTICS_SECRET` later makes new visits of the same anonymous visitors look like new visitors.
- **Config (`config.ini [web]`)**: `clarity_id` (Clarity Project ID, empty = off), `analytics_enabled`
  (false = the client sends nothing, API answers 404), `admin_cookie_secure` (keep `true` on the server; `false`
  only for local http).
- **Clarity Project ID**: https://clarity.microsoft.com -> New project (Website `https://promos.centerai.eu`) ->
  Settings -> Overview -> Project ID; put it into `clarity_id`, then `docker compose up -d --force-recreate api web`.
- **Opening `/admin`**: `https://promos.centerai.eu/admin` (not linked from the site, `noindex`), enter `ADMIN_PASSWORD`.
  The session lasts 12 hours; 5 wrong passwords per IP lock the login for 15 minutes.
- **Data**: `data/analytics.sqlite3` (api and bot containers both mount `./data`). Back it up with `data/`.
- **Retention**: the api process deletes events older than 13 months (~403 days) at startup and every 24 hours
  (the log shows only the count). Visitor profiles and sessions stay until deleted in `/admin`
  (user card -> delete, removes the visitor, sessions and events).
- **Bot**: every `/start` records `bot_start` server-side (platform `bot`); deep links `start=s_<campaign>[-<placement>]`.
  An analytics failure never blocks the bot reply.
