"""Derived price facts for the catalog - the single source of price logic.

The frontend only formats these fields; it never re-derives prices.

Key rule for multibuy: ``price_cents`` of a condition is the TOTAL for
``min_qty`` units. Comparisons and sorting use the per-item price
(``total / min_qty``); the total is shown separately with its quantity and is
never compared with single-item prices.
"""

from __future__ import annotations

from typing import Any

from .units import unit_price

OFFER_KINDS = ("promo", "loyalty", "multibuy")


def _per_item(p: dict[str, Any]) -> float:
    return p["price_cents"] / max(int(p.get("min_qty") or 1), 1)


def _rank(p: dict[str, Any]) -> tuple:
    # cheapest per item; on ties prefer no loyalty program, then smaller quantity
    return (_per_item(p), bool(p.get("program")), int(p.get("min_qty") or 1))


def _discount(p: dict[str, Any], regular: int | None) -> int | None:
    """Published discount of the condition, else computed on the same quantity basis."""
    if p.get("discount_pct"):
        return int(p["discount_pct"])
    if regular:
        qty = int(p.get("min_qty") or 1)
        full = regular * qty
        if p["price_cents"] < full:
            return round((full - p["price_cents"]) * 100 / full)
    return None


def _condition(p: dict[str, Any], regular: int | None) -> dict[str, Any]:
    qty = int(p.get("min_qty") or 1)
    per_item = _per_item(p)
    return {
        "kind": p["kind"],
        "program": p.get("program") or None,
        "min_qty": qty,
        "total_cents": p["price_cents"],  # amount to pay for min_qty units
        "per_item_cents": round(per_item),  # comparable price of ONE unit
        "discount_pct": _discount(p, regular),
        "text": p.get("condition_text") or None,
    }


def derive(prices: list[dict[str, Any]], unit_text: str | None, name: str) -> dict[str, Any]:
    """Return {best, no_card, regular_cents, savings_per_item_cents, unit_price}.

    - ``best``: cheapest per-item condition among promo/loyalty/multibuy;
      falls back to regular (kind "regular") when that is the only price.
    - ``no_card``: cheapest condition WITHOUT a loyalty program (may equal best);
      when only card prices exist, the known regular price.
    - ``unit_price``: per kg/l of ``best``'s per-item price, reliable data only.
    """
    regular_cond = next((p for p in prices if p["kind"] == "regular" and int(p.get("min_qty") or 1) == 1), None)
    regular = regular_cond["price_cents"] if regular_cond else None
    offers = [p for p in prices if p["kind"] in OFFER_KINDS and p.get("price_cents") is not None]

    best_raw = min(offers, key=_rank) if offers else regular_cond
    best = _condition(best_raw, regular) if best_raw else None
    if best and best["kind"] == "regular":
        best["discount_pct"] = None

    plain = [p for p in offers if not p.get("program")]
    if plain:
        no_card = _condition(min(plain, key=_rank), regular)
    elif regular_cond and offers:
        no_card = _condition(regular_cond, None)
        no_card["discount_pct"] = None
    else:
        no_card = None

    savings = None
    if best and regular and best["kind"] != "regular":
        diff = regular - best["per_item_cents"]  # docs/API.md: regular - best per-item (rounded) price
        savings = diff if diff > 0 else None

    up = unit_price(best["total_cents"] / best["min_qty"], unit_text, name) if best else None
    return {
        "best": best,
        "no_card": no_card,
        "regular_cents": regular,
        "savings_per_item_cents": savings,
        "unit_price": up,
    }
