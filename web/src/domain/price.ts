import type { Offer, PriceCondition, Program, UnitPrice } from "./types";

const NBSP = " ";

/** 199 -> "1,99 €" (comma decimal, NBSP before the euro sign). */
export function formatEUR(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const euros = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  return `${sign}${euros},${rest}${NBSP}€`;
}

/** "4,99 €/кг"; computed values get "≈ " prefix. Never computes anything. */
export function formatUnitPrice(unit: UnitPrice): string {
  const per = unit.per === "kg" ? "кг" : "л";
  const prefix = unit.source === "computed" ? "≈ " : "";
  return `${prefix}${formatEUR(unit.cents)}/${per}`;
}

export interface ConditionChip {
  /** i18n key */
  key: string;
  params?: Record<string, string | number>;
}

export const PROGRAM_KEYS: Record<Program, string> = {
  lidl_plus: "program.lidl_plus",
  kaufland_card: "program.kaufland_card",
  billa_card: "program.billa_card",
  billa_app: "program.billa_app",
};

/** Mandatory condition chips for any shown price condition. */
export function conditionChips(c: PriceCondition): ConditionChip[] {
  if (c.kind === "regular") return [{ key: "cond.regular" }];
  const chips: ConditionChip[] = [];
  if (c.min_qty > 1) chips.push({ key: "cond.multibuy", params: { n: c.min_qty } });
  if (c.program) chips.push({ key: PROGRAM_KEYS[c.program] });
  if (chips.length === 0) chips.push({ key: "cond.all" });
  return chips;
}

export type NoCardInfo =
  | { state: "value"; cents: number; qty: number; perItemCents: number }
  | { state: "unknown" };

export interface PriceModel {
  /** Big amount: total for multibuy, per-item otherwise. null if offer has no price. */
  mainCents: number | null;
  /** min_qty of the main price (>1 means multibuy). */
  qty: number;
  /** Per-item price line, only for multibuy. */
  perItemCents: number | null;
  chips: ConditionChip[];
  /** Only from best.discount_pct; null for regular prices. */
  discountPct: number | null;
  /** Struck-through reference price on the same quantity. */
  struckCents: number | null;
  /** Shown only when best requires a loyalty program. */
  noCard: NoCardInfo | null;
  /** Unit price text, e.g. "≈ 4,99 €/кг". */
  unitText: string | null;
  unitComputed: boolean;
  savingsPerItemCents: number | null;
}

export function priceModel(offer: Offer): PriceModel {
  const best = offer.best;
  if (!best) {
    return {
      mainCents: null,
      qty: 1,
      perItemCents: null,
      chips: [],
      discountPct: null,
      struckCents: null,
      noCard: null,
      unitText: null,
      unitComputed: false,
      savingsPerItemCents: null,
    };
  }
  const qty = best.min_qty > 1 ? best.min_qty : 1;
  const isRegular = best.kind === "regular";

  let struck: number | null = null;
  if (offer.regular_cents != null && !isRegular) {
    struck = qty > 1 ? offer.regular_cents * qty : offer.regular_cents;
  }

  let noCard: NoCardInfo | null = null;
  if (best.program) {
    // The quantity basis is always kept next to the amount (a multibuy total is not a per-item price).
    noCard = offer.no_card
      ? {
          state: "value",
          cents: offer.no_card.total_cents,
          qty: offer.no_card.min_qty > 1 ? offer.no_card.min_qty : 1,
          perItemCents: offer.no_card.per_item_cents,
        }
      : { state: "unknown" };
  }

  return {
    mainCents: best.total_cents,
    qty,
    perItemCents: qty > 1 ? best.per_item_cents : null,
    chips: conditionChips(best),
    discountPct: isRegular ? null : best.discount_pct,
    struckCents: struck,
    noCard,
    unitText: offer.unit_price ? formatUnitPrice(offer.unit_price) : null,
    unitComputed: offer.unit_price?.source === "computed",
    savingsPerItemCents: offer.savings_per_item_cents,
  };
}
