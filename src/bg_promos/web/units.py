"""Price per kg / l - only from reliable quantity data.

Rules (stage 2 requirement "no unreliable calculations"):
- ``published``: the chain states the price is already per kg/l
  ("за kg", "по kg", "кг", "За 1 кг").
- ``computed``: exactly one net quantity for one pack ("400 г", "0.7 l/опаковка").
- Nothing for ranges ("50 - 150 мл"), multipliers ("2 х 400 г", "32 + 8 бр."),
  pieces, or when the product name mentions several different quantities
  ("Шампоан 400 мл или Спрей 200 мл").
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_PER_KG_RE = re.compile(r"^(?:за|по)?\s*1?\s*(?:kg|кг)\.?$")
_PER_L_RE = re.compile(r"^(?:за|по)?\s*1?\s*(?:l|л)\.?$")
_SINGLE_RE = re.compile(r"^(\d+(?:\.\d+)?)\s*(kg|кг|g|г|гр|l|л|ml|мл)\.?(?:\s*(?:pet|рет|bib|бут\.?|кен))?$")
_QTY_IN_NAME_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*(kg|кг|g|г|гр|l|л|ml|мл)(?![a-zа-я])", re.I)
_DASH = "-‐‑‒–—−"
_UNIT_ALT = r"(?:kg|кг|g|г|гр|l|л|ml|мл)(?![a-zа-я])"
# "2 x 400 г", "2х400г", "3 бр. x ..." and any "+" (e.g. "32 + 8 бр.").
_MULTI_IN_NAME_RE = re.compile(r"\d\s*[xх×]\s*\d|(?:бр\.?|pcs\.?)\s*[xх×](?![a-zа-я])|\+", re.I)
# "200-400 г", "200 - 400г", "200 г – 400 г" (hyphen or any dash).
_RANGE_IN_NAME_RE = re.compile(
    rf"\d+(?:[.,]\d+)?\s*(?:{_UNIT_ALT})?\s*[{_DASH}]\s*\d+(?:[.,]\d+)?\s*{_UNIT_ALT}", re.I
)

_FACTORS = {
    "kg": (1000, "kg"), "кг": (1000, "kg"), "g": (1, "kg"), "г": (1, "kg"), "гр": (1, "kg"),
    "l": (1000, "l"), "л": (1000, "l"), "ml": (1, "l"), "мл": (1, "l"),
}
# sanity bounds for EUR per kg/l; outside -> treat as unreliable
_MIN_CENTS_PER_BASE = 5
_MAX_CENTS_PER_BASE = 100_000


@dataclass(frozen=True, slots=True)
class Quantity:
    base: str  # "kg" | "l"
    amount_milli: int  # grams or millilitres per pack; 1000 for "per kg/l" pricing
    published: bool  # True when the price itself is per kg/l


def _norm(text: str) -> str:
    t = text.lower().replace(",", ".").replace("\xa0", " ")
    t = re.sub(r"/\s*(опаковка|бр\.?|пакет|комплект)$", "", t.strip())
    return " ".join(t.split())


def parse_quantity(unit_text: str | None, name: str = "") -> Quantity | None:
    if not unit_text:
        return None
    u = _norm(unit_text)
    if _PER_KG_RE.match(u):
        return Quantity("kg", 1000, True)
    if _PER_L_RE.match(u):
        return Quantity("l", 1000, True)
    m = _SINGLE_RE.match(u)
    if not m:
        return None
    value = float(m.group(1))
    factor, base = _FACTORS[m.group(2)]
    amount = round(value * factor)
    if amount <= 0:
        return None
    # Multipacks / compound quantities / ranges anywhere in the name: the unit text alone
    # does not describe what is sold.
    if _MULTI_IN_NAME_RE.search(name or "") or _RANGE_IN_NAME_RE.search(name or ""):
        return None
    # The name must not mention a different quantity (variants of different size).
    for v, unit in _QTY_IN_NAME_RE.findall(name or ""):
        f, b = _FACTORS[unit.lower()]
        other = round(float(v.replace(",", ".")) * f)
        if b != base or other != amount:
            return None
    return Quantity(base, amount, False)


def sale_unit(unit_text: str | None) -> str:
    """How the price is quoted, from the source's unit text only (never guessed from the name):
    "kg" / "l" when the chain states the price is per kg/l ("За 1 кг", "за kg", "кг"),
    otherwise "piece" (a pack or an item)."""
    # "1 кг" / "1 л" is a pre-packed item of that size (sugar 1 кг, milk 1 л) -> piece.
    u = _norm(unit_text or "")
    if re.fullmatch(r"(?:(?:за|по)\s*(?:1\s*)?(?:kg|кг)|(?:kg|кг))\.?", u):
        return "kg"
    if re.fullmatch(r"(?:за|по)\s*(?:1\s*)?(?:l|л)\.?", u):
        return "l"
    return "piece"


def unit_price(per_item_cents: float, unit_text: str | None, name: str = "") -> dict | None:
    """Price per kg/l for one pack costing ``per_item_cents``; None when unreliable."""
    q = parse_quantity(unit_text, name)
    if q is None or per_item_cents <= 0:
        return None
    cents = per_item_cents if q.published else per_item_cents * 1000 / q.amount_milli
    cents = round(cents)
    if not (_MIN_CENTS_PER_BASE <= cents <= _MAX_CENTS_PER_BASE):
        return None
    return {"cents": cents, "per": q.base, "source": "published" if q.published else "computed"}
