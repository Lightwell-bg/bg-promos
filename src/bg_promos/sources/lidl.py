"""Lidl Bulgaria adapter.

Source: the JSON search API behind lidl.bg (``/q/api/search``). Every item is
``items[i].gridbox.data``. The whole assortment comes back, so only items with
a real promotion are kept: a crossed-out old price, a percentage discount or a
Lidl Plus (member) price. Member-only items have no ``price.price`` at all -
the member price and the regular price live inside the ``lidlPlus`` list.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import date, datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup

from ..models import Offer, PriceCondition, pct_off, to_cents
from .base import RawDocument, SourceFormatError

log = logging.getLogger(__name__)

CHAIN = "lidl"
SITE = "https://www.lidl.bg"
_PCT_RE = re.compile(r"(\d{1,3})\s*%")


class LidlSource:
    chain = CHAIN

    def __init__(
        self,
        api_url: str = f"{SITE}/q/api/search",
        page_size: int = 60,
        max_pages: int = 60,
        tz: ZoneInfo | str = "Europe/Sofia",
    ) -> None:
        self.api_url = api_url
        self.page_size = page_size
        self.max_pages = max_pages
        self.tz = ZoneInfo(tz) if isinstance(tz, str) else tz

    def fetch(self, http) -> list[RawDocument]:
        docs: list[RawDocument] = []
        offset = total = 0
        for page in range(self.max_pages):
            params = {
                "assortment": "BG",
                "locale": "bg_BG",
                "version": "v2.0.0",
                "fetchsize": self.page_size,
                "offset": offset,
            }
            resp = http.get(self.api_url, params=params)
            docs.append(
                RawDocument(f"page-{page:04d}", self.api_url, resp.content, resp.headers.get("content-type", ""))
            )
            data = _load(docs[-1])
            items = data["items"]
            offset += len(items)
            total = int(data["numFound"])
            if offset >= total:
                break
            if not items:
                raise SourceFormatError(f"Lidl: empty page at offset {offset} of {total} (truncated catalogue)")
        else:
            raise SourceFormatError(
                f"Lidl: stopped at max_pages={self.max_pages} with offset {offset} of {total} (truncated catalogue)"
            )
        return docs

    def parse(self, docs: list[RawDocument], today: date | None = None) -> list[Offer]:
        today = today or datetime.now(self.tz).date()
        offers: dict[tuple, Offer] = {}
        for doc in docs:
            data = _load(doc)
            items = data["items"]
            parsed = 0
            for item in items:
                g = (item.get("gridbox") or {}).get("data") if isinstance(item, dict) else None
                if not isinstance(g, dict):
                    continue
                parsed += 1
                try:
                    offer = self._parse_item(g, today)
                except (KeyError, TypeError, ValueError) as exc:
                    log.warning("Lidl: skip item %r: %s", g.get("productId"), exc)
                    continue
                if offer:
                    offers.setdefault((offer.source_key, offer.valid_from, offer.valid_to), offer)
            if items and not parsed:
                raise SourceFormatError(f"Lidl: no gridbox.data in items of {doc.name}")
        return list(offers.values())

    def _parse_item(self, g: dict[str, Any], today: date) -> Offer | None:
        price = g.get("price") or {}
        discount = price.get("discount") or {}
        valid_from = self._to_date(g.get("storeStartDate"))
        valid_to = self._to_date(g.get("storeEndDate"))
        if valid_to is not None and valid_to < today:
            return None

        main = to_cents(price.get("price"))
        old = to_cents(price.get("oldPrice")) or to_cents(discount.get("deletedPrice")) or None
        published_pct = discount.get("percentageDiscount") or None

        loyalty: PriceCondition | None = None
        lp_old: int | None = None
        for entry in _lidl_plus_entries(g):
            lp = entry.get("price") or {}
            lp_price = to_cents(lp.get("price"))
            if lp_price is None:
                continue
            lp_disc = lp.get("discount") or {}
            lp_old = to_cents(lp.get("oldPrice")) or to_cents(lp_disc.get("deletedPrice")) or None
            m = _PCT_RE.search(str(lp_disc.get("discountText") or entry.get("highlightText") or ""))
            pct = int(m.group(1)) if m else pct_off(lp_old, lp_price)
            loyalty = PriceCondition(
                "loyalty", lp_price, program="lidl_plus", discount_pct=pct,
                condition_text=entry.get("lidlPlusText") or None,
            )
            break

        prices: list[PriceCondition] = []
        has_promo = main is not None and ((old is not None and old > main) or bool(published_pct))
        if has_promo:
            if old is not None and old > main:
                prices.append(PriceCondition("regular", old))
            prices.append(
                PriceCondition("promo", main, discount_pct=published_pct or pct_off(old, main))
            )
        elif loyalty:
            reference = main if main is not None else lp_old  # plain shelf price when no old price
            if reference is not None and reference > loyalty.price_cents:
                prices.append(PriceCondition("regular", reference))
        else:
            return None
        if loyalty:  # kept even without a known reference price: it is still a promotion
            prices.append(loyalty)

        product_id = str(g["productId"])
        keyfacts = g.get("keyfacts") or {}
        path = g.get("canonicalPath")
        return Offer(
            chain=CHAIN,
            source_key=product_id,
            product_ref=product_id,
            name=" ".join((g.get("fullTitle") or g.get("title") or keyfacts.get("fullTitle") or "").split()),
            valid_from=valid_from,
            valid_to=valid_to,
            prices=prices,
            brand=(g.get("brand") or {}).get("name") or None,
            description=_plain_text(keyfacts.get("description")),
            category=g.get("category") or keyfacts.get("wonCategoryPrimary") or None,
            unit_text=(price.get("packaging") or {}).get("text") or _lp_unit(g),
            image_url=g.get("image") or None,
            product_url=f"{SITE}{path}" if path else None,
            raw={
                k: g[k]
                for k in ("productId", "price", "lidlPlus", "storeStartDate", "storeEndDate", "badges")
                if k in g
            },
        )

    def _to_date(self, epoch: Any) -> date | None:
        if not epoch:
            return None
        return datetime.fromtimestamp(int(epoch), tz=timezone.utc).astimezone(self.tz).date()


def _load(doc: RawDocument) -> dict[str, Any]:
    try:
        data = json.loads(doc.content)
    except ValueError as exc:
        raise SourceFormatError(f"Lidl: {doc.name} is not JSON: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("items"), list) or "numFound" not in data:
        raise SourceFormatError(f"Lidl: {doc.name} has no items/numFound")
    return data


def _lidl_plus_entries(g: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for container in (g, g.get("price") or {}):
        value = container.get("lidlPlus")
        if isinstance(value, list):
            out.extend(e for e in value if isinstance(e, dict))
    return out


def _lp_unit(g: dict[str, Any]) -> str | None:
    for entry in _lidl_plus_entries(g):
        text = ((entry.get("price") or {}).get("packaging") or {}).get("text")
        if text:
            return text
    return None


def _plain_text(html: str | None) -> str | None:
    if not html:
        return None
    text = " ".join(BeautifulSoup(html, "html.parser").get_text(" ").split())
    return text or None
