"""Kaufland Bulgaria adapter.

Source: the offers page, which embeds its data as ``window.SSR['<uuid>'] = {...}``
inside a script. The payload lives at
``props.offerData.cycles[].categories[].offers[]`` (cycles = current and next
week). One offer can be listed in several categories; the first one wins.
Many offers carry no price at all (the deal is described in text) - those are
kept with ``prices=[]``.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from ..models import Offer, PriceCondition, pct_off, to_cents
from .base import RawDocument, SourceFormatError

log = logging.getLogger(__name__)

CHAIN = "kaufland"
DEFAULT_URL = "https://www.kaufland.bg/aktualni-predlozheniya/oferti.html"
_SSR_RE = re.compile(r"window\.SSR\['[^']+'\]\s*=\s*")
_MULTIBUY_RE = re.compile(r"(?<!\d)([1-9])\s*\+\s*([1-9])(?!\d)")


class KauflandSource:
    chain = CHAIN

    def __init__(self, url: str = DEFAULT_URL, tz: ZoneInfo | str = "Europe/Sofia") -> None:
        self.url = url
        self.tz = ZoneInfo(tz) if isinstance(tz, str) else tz

    def fetch(self, http) -> list[RawDocument]:
        resp = http.get(self.url)
        return [RawDocument("offers", self.url, resp.content, resp.headers.get("content-type", ""))]

    def parse(self, docs: list[RawDocument], today: date | None = None) -> list[Offer]:
        today = today or datetime.now(self.tz).date()
        if not docs:
            raise SourceFormatError("Kaufland: no documents")
        cycles = _find_cycles(docs[0].text)
        offers: dict[str, Offer] = {}
        for cycle in cycles:
            for category in cycle.get("categories") or []:
                cat_name = category.get("displayName") or None
                for item in category.get("offers") or []:
                    offer_id = str(item.get("offerId") or "")
                    if not offer_id or offer_id in offers:
                        continue
                    try:
                        offer = _parse_offer(item, cat_name)
                    except (TypeError, ValueError) as exc:
                        log.warning("Kaufland: skip offer %s: %s", offer_id, exc)
                        continue
                    if offer.valid_to is not None and offer.valid_to < today:
                        continue
                    offers[offer_id] = offer
        return list(offers.values())


def _find_cycles(html: str) -> list[dict[str, Any]]:
    decoder = json.JSONDecoder()
    for m in _SSR_RE.finditer(html):
        try:
            blob, _ = decoder.raw_decode(html, m.end())
        except ValueError:
            continue
        try:
            cycles = blob["props"]["offerData"]["cycles"]
        except (KeyError, TypeError):
            continue
        if isinstance(cycles, list):
            return cycles
    raise SourceFormatError("Kaufland: window.SSR blob with props.offerData.cycles not found")


def _clean(text: Any) -> str:
    return " ".join(str(text or "").split())


def _date(value: Any) -> date | None:
    return date.fromisoformat(value) if value else None


def _parse_offer(item: dict[str, Any], category: str | None) -> Offer:
    offer_id = str(item["offerId"])
    name = " ".join(x for x in (_clean(item.get("title")), _clean(item.get("subtitle"))) if x)
    detail_title = _clean(item.get("detailTitle"))
    detail_desc = _clean(item.get("detailDescription"))
    description: str | None = detail_desc or None
    if not name:
        # Brand-wide card discounts have no title/subtitle: the scope of the
        # discount ("на всички артикули марка Хисар") is the only usable name
        # and the headline ("-20% отстъпка с KAUFLAND CARD XTRA") its description.
        if detail_desc:
            name = detail_desc
            description = detail_title or None
        else:
            name = detail_title or f"Артикул {item.get('klNr') or offer_id}"
    label = item.get("label")
    return Offer(
        chain=CHAIN,
        source_key=offer_id,
        product_ref=str(item.get("klNr") or offer_id),
        name=name,
        valid_from=_date(item.get("dateFrom")),
        valid_to=_date(item.get("dateTo")),
        prices=_prices(item),
        description=description,
        category=category,
        unit_text=_clean(item.get("unit")) or None,
        offer_label=label if label and label != "none" else None,
        image_url=item.get("listImage") or None,
        raw={
            k: item[k]
            for k in ("offerId", "klNr", "price", "discount", "label", "formattedPrice", "formattedOldPrice",
                      "loyaltyDiscount", "loyaltyFormattedPrice", "loyaltyFormattedOldPrice", "detailTitle",
                      "bonusbuy", "bbyNo")
            if k in item
        },
    )


def _multibuy(item: dict[str, Any]) -> list[PriceCondition] | None:
    """"ВЗЕМИ a+b БЕЗПЛАТНО" deals: shown price is the total for a+b units.

    Returns None when the offer is not a multibuy (or carries no price), so the
    regular promo/loyalty logic applies.
    """
    title = _clean(item.get("detailTitle"))
    m = _MULTIBUY_RE.search(title)
    if not m:
        return None
    qty = int(m.group(1)) + int(m.group(2))
    if qty < 2:
        return None
    total = to_cents(item.get("price"))
    for key in ("formattedPrice", "loyaltyFormattedPrice"):
        if total is None:
            total = to_cents(item.get(key))
    old_total = to_cents(item.get("formattedOldPrice"))
    if old_total is None:
        old_total = to_cents(item.get("loyaltyFormattedOldPrice"))
    if total is None:
        return None
    pct = item.get("discount") or item.get("loyaltyDiscount") or None
    out: list[PriceCondition] = []
    if old_total is not None and old_total > 0:
        out.append(PriceCondition("regular", round(old_total / qty)))
    out.append(
        PriceCondition(
            "multibuy", total, min_qty=qty,
            program="kaufland_card" if "CARD" in title.upper() else None,
            discount_pct=int(pct) if pct else None,
            condition_text=title,
        )
    )
    return out


def _prices(item: dict[str, Any]) -> list[PriceCondition]:
    multibuy = _multibuy(item)
    if multibuy is not None:
        return multibuy
    promo = to_cents(item.get("price"))
    if promo is None:
        promo = to_cents(item.get("formattedPrice"))
    regular = to_cents(item.get("formattedOldPrice"))
    loyalty = to_cents(item.get("loyaltyFormattedPrice"))
    loyalty_old = to_cents(item.get("loyaltyFormattedOldPrice"))

    if regular is None and loyalty_old is not None:
        reference = promo if promo is not None else loyalty
        if reference is not None and loyalty_old > reference:
            regular = loyalty_old

    out: list[PriceCondition] = []
    if regular is not None and (promo is None or regular > promo) and (loyalty is None or regular > loyalty):
        out.append(PriceCondition("regular", regular))
    if promo is not None:
        pct = item.get("discount") or pct_off(regular, promo)
        out.append(PriceCondition("promo", promo, discount_pct=int(pct) if pct else None))
    if loyalty is not None:
        pct = item.get("loyaltyDiscount") or None
        out.append(
            PriceCondition(
                "loyalty", loyalty, program="kaufland_card",
                discount_pct=int(pct) if pct else None,
            )
        )
    return out
