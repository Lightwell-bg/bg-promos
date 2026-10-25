# BG Promos API v1 (stage 2)

Base path: `/api`. All money values are integer EUR cents. Dates are `YYYY-MM-DD`
in Europe/Sofia; timestamps are ISO 8601 with offset.

## GET /api/health
`{"status": "ok", "db": true}`; 503 with `"db": false` when the database cannot be opened.

## GET /api/v1/catalog
The whole current + upcoming catalog (expired offers are excluded). Supports
`ETag` / `If-None-Match` (304). `Cache-Control: no-cache`. Served gzip-compressed
when the client accepts it.

The server cache key is (id of the last successful run per chain, today's date in
Europe/Sofia, current UTC hour `YYYY-MM-DDTHH`): the catalog is rebuilt after a new
collection, at midnight Sofia and at least hourly (so time-based chain `stale` flags
stay fresh). The ETag is computed over the payload **without** `generated_at`; when an
hourly rebuild yields identical content the previous bytes and ETag are kept, so
`generated_at` is the time the content last changed and clients keep getting 304.
The ETag changes only when content changes (new run, new day, a `stale` flag flip).
Clients must still compute "active / upcoming / ended" from `valid_from`/`valid_to`
against the current Sofia date, because a cached copy can be used offline.

```json
{
  "version": 1,
  "generated_at": "2026-10-17T16:05:00+03:00",
  "today": "2026-10-17",
  "currency": "EUR",
  "chains": {
    "lidl": {
      "name": "Lidl",
      "status": "ok",
      "stale": false,
      "stale_reason": null,
      "last_success_at": "2026-10-17T12:55:59+00:00",
      "offers_url": "https://www.lidl.bg/",
      "brochure_url": "https://www.lidl.bg/c/broshura/s10020060"
    }
  },
  "categories": [{"id": "produce", "bg": "Плодове и зеленчуци", "ru": "Фрукты и овощи", "icon": "🥦"}],
  "offers": [Offer]
}
```

### Offer
| field | type | notes |
|---|---|---|
| id | string | stable, URL-safe: first 12 hex of sha1(`chain|source_key|valid_from|valid_to`) |
| chain | `"lidl" \| "kaufland" \| "billa"` | |
| product_ref | string | stable product id inside the chain |
| name | string | original product name, never translated |
| brand | string \| null | |
| description | string \| null | conditions, origin, limits (original text) |
| category | string | id from `categories` |
| chain_category | string \| null | the chain's own category text |
| unit_text | string \| null | pack size as published |
| label | string \| null | chain offer label / tags |
| image_url | string \| null | chain CDN; null for BILLA |
| source_url | string | product page if known, else the chain offers/brochure page |
| source_is_product | boolean | true when `source_url` is the product page |
| valid_from / valid_to | date \| null | inclusive |
| first_seen_at | timestamp | when we first saw this offer ("new" badge) |
| prices | PriceCondition[] | all conditions as published |
| best | PriceCondition \| null | cheapest PER ITEM among promo/loyalty/multibuy; falls back to regular |
| no_card | PriceCondition \| null | cheapest condition without a loyalty program; or the regular price when only card prices exist |
| regular_cents | int \| null | regular price of ONE item |
| savings_per_item_cents | int \| null | regular − best per-item price; null when regular is unknown |
| unit_price | UnitPrice \| null | per kg / l of `best`, only from reliable data |
| sale_unit | `"kg" \| "l" \| "piece"` | how the price is quoted, from `unit_text` only: `kg`/`l` when the chain states the price is per kg/l ("За 1 кг", "за kg", "по 1 л"); pre-packed "1 кг"/"1 л" and everything else is `piece`. Clients treat a missing value as `piece` |
| alt_ids | string[] | ids of equivalent offers of the same chain (exactly equal name, description, pack size and brand, overlapping validity), e.g. Lidl listing the same goods twice under different product ids; `[]` when none. Such offers share the union of their `prices` (one regular price) and the re-derived `best` / `no_card` / `regular_cents` / `savings_per_item_cents` / `unit_price` |

### PriceCondition
| field | type | notes |
|---|---|---|
| kind | `"regular" \| "promo" \| "loyalty" \| "multibuy"` | |
| program | `"lidl_plus" \| "kaufland_card" \| "billa_card" \| "billa_app"` \| null | loyalty program required |
| min_qty | int | units that must be bought together (1 unless multibuy) |
| total_cents | int | amount to pay for `min_qty` units |
| per_item_cents | int | `total_cents / min_qty`, rounded — the only value used to compare/sort prices |
| discount_pct | int \| null | published, else computed on the same quantity (regular × min_qty vs total); null when unknown |
| text | string \| null | original condition text (e.g. "1+1: 2 бр. за 1,99 €", cashback note) |

Rule: a multibuy `total_cents` is never shown or compared as if it were a single-item price.

### UnitPrice
`{"cents": 499, "per": "kg" | "l", "source": "published" | "computed"}` — `computed`
only from one exact net quantity (no ranges, multipliers or size variants).

## GET /api/v1/meta
`{"generated_at", "today", "chains": {...}}` — the same chain block as the catalog,
for a cheap freshness check.

## GET /api/v1/config
```json
{
  "ga4_id": "G-XXXXXXX or null",
  "clarity_id": "Microsoft Clarity project id or null (config.ini [web] clarity_id)",
  "analytics_enabled": true,
  "contact_email": "info@centerai.eu",
  "operator": "CenterAI",
  "site_url": "https://promos.centerai.eu",
  "brochures": {"lidl": "https://...", "kaufland": "https://...", "billa": "https://..."},
  "report_enabled": true,
  "telegram_bot": "promoseubot or null (config.ini [bot] username; cart share links open t.me/<bot>?startapp=...)"
}
```

## POST /api/v1/report
Request JSON: `{"message": str (5..1000), "offer_id": str|null, "page_url": str|null (≤300),
"lang": "bg"|"ru", "hp": "" (honeypot, must be empty), "elapsed_ms": int (time the form was open)}`.

Responses: `200 {"ok": true}`; `400` invalid; `429` rate limited; `503` reporting not configured
or Telegram unavailable. Anti-spam: honeypot, `elapsed_ms ≥ 3000`, per-IP 5/hour and
20/day, global 100/day, in-memory. Client IP = `X-Forwarded-For` first hop only when the
direct peer is 127.0.0.1 / the Docker gateway, else the peer address. The message is sent
to Telegram as plain text (no parse_mode).

## Internal analytics (public)
Contract and event whitelist: `docs/ANALYTICS.md`. Both endpoints answer `404` when
`config.ini [web] analytics_enabled = false`. Body limit 32 KB (`413`, checked on
Content-Length and on the actual bytes); rate limits in memory (per IP 600 requests/min,
per session 120 requests/min) -> `429`. Invalid JSON/shape -> `400`.

### POST /api/v1/analytics/session
Request: `{"session_id": uuid, "platform": "web"|"miniapp", "anon_id": uuid (web), "init_data": str (miniapp),
"lang": str?, "utm": {utm_source, utm_medium, utm_campaign, utm_content}?, "referrer": str?, "start_param": ignored, "test": bool?}`.
- Mini App: `init_data` is verified with `PROMOS_BOT_TOKEN`; failure -> `401` (nothing is logged except the error class).
  Identity and `start_param` come ONLY from the verified data (`s_<campaign>[-<placement>]` or `s_…__c1_…`).
- Web: `anon_id` is hashed `sha256(ANALYTICS_SECRET + anon_id)`; source = UTM, else external referrer, else unknown.
- Idempotent on `session_id`; a session id owned by another visitor -> `409`.
- User agents of headless browsers/bots/previews set `is_automated`; `test: true` sets `is_test`.

Response `200`: `{"token": str, "visitor_id": "v_…"}` (`token` = HMAC of session|visitor; send it with every event batch).
With an empty `ANALYTICS_SECRET` the secret is random per process, so after an API restart `events` answers `401`
and the client must call `session` again (same `session_id`) to get a new token.

### POST /api/v1/analytics/events
Request: `{"token": str, "session_id": uuid, "events": [{"event_id": uuid, "name": str, "ts": ISO 8601, "props": {}}]}`, at most 50 events.
Unknown names/props, wrong types, `ts` more than 2 days from server time and the server-only names
(`bot_start`, `site_open`, `miniapp_open`) are rejected per event; the rest of the batch is stored.
Response: `200 {"accepted": n, "duplicates": n, "rejected": [{"index": i, "error": str}]}`;
`400` when more than 50 events or when every event was rejected (same body); `401` bad token / unknown session.
Duplicate `event_id` is ignored (idempotent re-send).

## Admin API (closed, same-origin only)
Enabled only when `ADMIN_PASSWORD` is set; otherwise every `/api/admin/*` answers `404`. All responses
carry `Cache-Control: no-store`. Auth is the cookie `bgp_admin` (HMAC-signed expiry, 12 h, HttpOnly,
SameSite=Strict, Path=/api/admin, Secure unless `config.ini [web] admin_cookie_secure = false`);
without it `401`. CORS does not allow credentials and these paths are not meant for cross-origin use.

- `POST /api/admin/login` `{"password": str}` -> `200 {"ok": true}` + cookie; `401` wrong password;
  `429` after 5 failed attempts per IP in 15 minutes.
- `POST /api/admin/logout` -> `200`, cookie deleted.
- `GET /api/admin/metrics` query: `from`, `to` (Sofia dates `YYYY-MM-DD`, default last 7 days; max 400 days),
  `platform` (web|miniapp|bot), `lang`, `source_kind` (utm|start|startapp|referrer|unknown), `source`, `campaign`,
  `include_test`, `include_automated` (default false = excluded). Response:
  ```json
  {"period": {"from": "2026-10-12", "to": "2026-10-18"},
   "users": {"total": 0, "tg": 0, "anon": 0}, "sessions": 0,
   "bot_starts": 0, "miniapp_opens": 0, "site_opens": 0, "catalog_loads": 0,
   "cart_add_users": 0, "share_links": 0, "imports_successful": 0, "returning_visitors": 0,
   "top_offers": {"viewed": [{"offer_id": "", "chain": "", "category": "", "count": 0}], "carted": []},
   "zero_result_queries": [{"query": "", "count": 0}],
   "errors": [{"name": "", "where": "", "count": 0}]}
  ```
  Offer names are not stored (the analytics DB is separate from the catalog): the UI resolves `offer_id` from the public catalog.
- `GET /api/admin/users` the same filters plus `q` (Telegram id, @username, first/last name or `v_…` id), `limit` (1..200, default 50),
  `offset`. Response `{"total", "limit", "offset", "items": [{"visitor_id", "kind": "tg"|"anon", "tg_id", "username",
  "first_name", "last_name", "language", "first_seen", "last_seen", "first_source": {kind, source, medium, campaign, placement},
  "sessions", "cart_adds"}]}`; `sessions`/`cart_adds` are counted inside the selected period and filters.
- `GET /api/admin/users/{visitor_id}` -> profile (`is_anonymous` true for site visitors, no Telegram fields),
  `sessions` (newest first, with source, flags and event count) and `events` (timeline, newest first, max 500); `404` unknown.
- `DELETE /api/admin/users/{visitor_id}` -> deletes the visitor, sessions and events; `404` unknown.
- `GET /api/admin/filters` -> `{"platforms", "langs", "source_kinds", "sources", "campaigns"}`.

Timestamps in analytics responses are UTC (`...Z`).

### Collection admin API ("Сбор данных")
Same auth as above. Schedule overrides and "collect now" requests live in `data/control.sqlite3`; the catalog DB is only read.
A chain disabled in `config.ini` answers `409 {"detail": "chain is disabled in config.ini"}` on the write endpoints;
an unknown chain is `404`; an unavailable control DB is `503`. Run timestamps are UTC ISO strings.

- `GET /api/admin/collection?days=7|30|90` (default `days=7`; anything else `422`) ->
  `{"now", "tz": "Europe/Sofia", "cron": "hourly at :00", "chains": [...]}`. Each chain:
  `{"chain", "config_enabled", "schedule": {"enabled", "slots": ["HH:MM"], "source": "config"|"admin", "revision", "updated_at"},
  "config_slots", "next_slot_at", "last_run", "last_ok_at", "stale", "period": {"runs", "ok", "suspicious", "failed", "running",
  "success_rate", "avg_duration_s", "avg_offers"}, "pending_request": {"id", "requested_at"}|null,
  "last_request": {"requested_at", "claimed_at", "finished_at", "status"}|null,
  "series": [{"started_at", "status", "offers_count", "active_count"}]}` (series capped at 500 runs of the period).
- `GET /api/admin/collection/runs?days=7|30|90[&chain=lidl|kaufland|billa][&status=ok|suspicious|failed|running][&limit=20][&offset=0]`
  -> `{"items": [...], "total", "limit", "offset"}`: the paged run list for the period (same `limit`/`offset` pattern as
  `/api/admin/users`; `limit` 1..100, default 20; a page past the end gives empty `items` with the real `total`). Newest
  first (`started_at`, then `id`). Bad `days`/`status`/`limit`/`offset` -> `422`, unknown `chain` -> `404`. Item:
  `{"id", "chain", "started_at", "finished_at", "status", "scheduled", "offers_count", "active_count", "content_changed",
  "error" (max 300 chars), "duration_s"}`.
- `PUT /api/admin/collection/schedule/{chain}` `{"enabled": bool, "slots": ["HH:MM", ...], "revision": int}` ->
  `200` the new schedule object; `409 {"detail": "stale", "current": {...}}` when `revision` is no longer current
  (optimistic lock: reload and retry); `422` invalid body or slots (HH:MM, no duplicates, at most 24, at least one when enabled).
- `DELETE /api/admin/collection/schedule/{chain}?revision=N` -> resets the chain to the `config.ini` schedule; `200` the
  schedule object (`source: "config"`); `409 stale` as above; `422` bad `revision`.
- `POST /api/admin/collection/run/{chain}` -> `202 {"request": {"id", "requested_at"}, "created": true}` for a new request,
  `200 {..., "created": false}` when one is already pending (one pending request per chain). The next hourly
  `collect --scheduled` claims it atomically and runs the chain.
  `last_request.status` is the run status (`ok`, `suspicious`, `failed`) or `interrupted` when the collector crashed after
  claiming the request (closed at the start of the next scheduled run; it is not re-run automatically).

## CORS
Allowed origins from `config.ini [web] cors_origins` (default: the site URL,
`capacitor://localhost`, `https://localhost`, `http://localhost:5173`). Methods GET, POST.
