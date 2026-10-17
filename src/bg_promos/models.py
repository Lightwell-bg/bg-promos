"""Normalized data model shared by all chain adapters.

Price conventions (all chains):
- Money is stored as integer euro cents (``int``), never ``float``.
- ``PriceCondition.price_cents`` is the amount paid for ``min_qty`` units
  (for ``min_qty == 1`` it is simply the unit price). Divide by ``min_qty``
  for a per-unit figure.
- ``kind``:
    * ``regular``  - reference / pre-promo price ("предишна цена", old price);
    * ``promo``    - the advertised offer price available to everyone;
    * ``loyalty``  - price available only with a loyalty program (``program``);
    * ``multibuy`` - price for buying ``min_qty`` units together (1+1, 2+1 ...).
  A single offer may carry several conditions at once.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import date
from typing import Any

PRICE_KINDS = ("regular", "promo", "loyalty", "multibuy")


@dataclass(frozen=True, slots=True)
class PriceCondition:
    kind: str
    price_cents: int
    min_qty: int = 1
    program: str | None = None  # lidl_plus | kaufland_card | billa_card | billa_app
    discount_pct: int | None = None  # relative to the regular price, as published
    condition_text: str | None = None

    def __post_init__(self) -> None:
        if self.kind not in PRICE_KINDS:
            raise ValueError(f"unknown price kind: {self.kind!r}")
        if self.price_cents < 0 or self.min_qty < 1:
            raise ValueError(f"invalid price condition: {self!r}")

    @property
    def key(self) -> tuple[str, str, int]:
        """Identity of a condition inside one offer (used for price history)."""
        return (self.kind, self.program or "", self.min_qty)


@dataclass(slots=True)
class Offer:
    chain: str
    source_key: str  # id of this offer at the source, unique per chain + validity
    product_ref: str  # stable product id inside the chain, across promo periods
    name: str
    valid_from: date | None
    valid_to: date | None
    prices: list[PriceCondition] = field(default_factory=list)
    brand: str | None = None
    description: str | None = None
    category: str | None = None
    unit_text: str | None = None
    offer_label: str | None = None
    image_url: str | None = None
    product_url: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    def price(self, kind: str, program: str | None = None) -> PriceCondition | None:
        for p in self.prices:
            if p.kind == kind and (program is None or p.program == program):
                return p
        return None

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["valid_from"] = self.valid_from.isoformat() if self.valid_from else None
        d["valid_to"] = self.valid_to.isoformat() if self.valid_to else None
        return d


def stable_hash(*parts: Any, length: int = 16) -> str:
    """Short deterministic hash for ids derived from text (e.g. BILLA product_ref)."""
    payload = json.dumps(parts, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:length]


def to_cents(value: Any) -> int | None:
    """Convert '1,99', '1.99', 1.99 or '1,99 €' to cents; None/empty/0-like junk -> None."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        cents = round(float(value) * 100)
    else:
        s = str(value).replace("\xa0", " ").replace("€", "").strip().replace(" ", "")
        if "." in s and "," in s:  # the last separator is the decimal one, the other groups thousands
            if s.rfind(",") > s.rfind("."):
                s = s.replace(".", "").replace(",", ".")
            else:
                s = s.replace(",", "")
        else:
            s = s.replace(",", ".")
        if not s:
            return None
        try:
            cents = round(float(s) * 100)
        except ValueError:
            return None
    return cents if cents >= 0 else None


def pct_off(regular_cents: int | None, price_cents: int | None) -> int | None:
    if not regular_cents or price_cents is None or price_cents >= regular_cents:
        return None
    return round((regular_cents - price_cents) * 100 / regular_cents)
