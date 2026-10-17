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
  "contact_email": "info@centerai.eu",
  "operator": "CenterAI",
  "site_url": "https://promos.centerai.eu",
  "brochures": {"lidl": "https://...", "kaufland": "https://...", "billa": "https://..."},
  "report_enabled": true
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

## CORS
Allowed origins from `config.ini [web] cors_origins` (default: the site URL,
`capacitor://localhost`, `https://localhost`, `http://localhost:5173`). Methods GET, POST.
