import { daysLeft, status } from "./dates";
import { CHAIN_IDS, type ChainId, type Offer, type PriceCondition } from "./types";

export type SortKey = "discount" | "price" | "savings" | "ending" | "store";
export type CardMode = "all" | "without" | "only";
export type WhenMode = "now" | "upcoming" | "all";

export const SORT_KEYS: readonly SortKey[] = ["discount", "price", "savings", "ending", "store"];
export const DISC_OPTIONS = [0, 10, 25, 50] as const;
export const ENDS_OPTIONS = [0, 1, 3, 7] as const;

export interface Filters {
  chains: ChainId[];
  cats: string[];
  q: string;
  sort: SortKey;
  /** per-item price bounds in cents */
  pmin: number | null;
  pmax: number | null;
  /** minimum discount percent; 0 = any */
  disc: number;
  card: CardMode;
  when: WhenMode;
  /** ends within N days; 0 = any */
  ends: number;
}

export const DEFAULT_FILTERS: Filters = {
  chains: [],
  cats: [],
  q: "",
  sort: "discount",
  pmin: null,
  pmax: null,
  disc: 0,
  card: "all",
  when: "now",
  ends: 0,
};

const CHAIN_ORDER: Record<ChainId, number> = { lidl: 0, kaufland: 1, billa: 2 };

/** Compares nullable numbers; nulls always last. `dir` 1 = ascending, -1 = descending. */
function cmpNullable(a: number | null | undefined, b: number | null | undefined, dir: 1 | -1): number {
  const an = a == null;
  const bn = b == null;
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  return (a - b) * dir;
}

/**
 * The price condition the user is looking at under the card filter:
 * - "without": the cheapest condition needing no program (best when it needs none, else no_card);
 *   null when only a card price is known;
 * - "only" / "all": the best condition.
 */
export function effectiveCondition(offer: Offer, card: CardMode = "all"): PriceCondition | null {
  const best = offer.best;
  if (card === "without") {
    if (best && !best.program) return best;
    return offer.no_card ?? null;
  }
  return best;
}

/** Savings per item for the effective condition (regular − per item); server value for best. */
export function effectiveSavings(offer: Offer, card: CardMode = "all"): number | null {
  const c = effectiveCondition(offer, card);
  if (!c) return null;
  if (c === offer.best) return offer.savings_per_item_cents;
  if (offer.regular_cents == null) return null;
  return offer.regular_cents - c.per_item_cents;
}

export function compareOffers(sort: SortKey, card: CardMode = "all"): (a: Offer, b: Offer) => number {
  const byDiscount = (a: Offer, b: Offer) =>
    cmpNullable(effectiveCondition(a, card)?.discount_pct, effectiveCondition(b, card)?.discount_pct, -1) ||
    cmpNullable(effectiveSavings(a, card), effectiveSavings(b, card), -1);
  switch (sort) {
    case "price":
      // per-item only: a multibuy total_cents is never comparable to a single price
      return (a, b) =>
        cmpNullable(effectiveCondition(a, card)?.per_item_cents, effectiveCondition(b, card)?.per_item_cents, 1);
    case "savings":
      return (a, b) => cmpNullable(effectiveSavings(a, card), effectiveSavings(b, card), -1);
    case "ending":
      return (a, b) => {
        const an = a.valid_to;
        const bn = b.valid_to;
        if (an == null && bn == null) return 0;
        if (an == null) return 1;
        if (bn == null) return -1;
        return an < bn ? -1 : an > bn ? 1 : 0;
      };
    case "store":
      return (a, b) => CHAIN_ORDER[a.chain] - CHAIN_ORDER[b.chain] || byDiscount(a, b);
    case "discount":
    default:
      return byDiscount;
  }
}

export function sortOffers(offers: Offer[], sort: SortKey, card: CardMode = "all"): Offer[] {
  // Array.prototype.sort is stable: ties keep catalog order.
  return [...offers].sort(compareOffers(sort, card));
}

/**
 * Filters (never mutates) and sorts. Ended offers are always dropped.
 * `matchIds` is the result of a text search when `filters.q` is set.
 */
export function filterOffers(
  offers: Offer[],
  f: Filters,
  today: string,
  matchIds?: Set<string> | null,
): Offer[] {
  const out = offers.filter((o) => {
    const st = status(o, today);
    const eff = effectiveCondition(o, f.card);
    if (st === "ended") return false;
    if (f.when === "now" && st !== "active") return false;
    if (f.when === "upcoming" && st !== "upcoming") return false;
    if (f.chains.length && !f.chains.includes(o.chain)) return false;
    if (f.cats.length && !f.cats.includes(o.category)) return false;
    if (matchIds && !matchIds.has(o.id)) return false;

    // "without card": buyable without a card (best needs none, or a no-card price exists).
    if (f.card === "without" && eff == null) return false;
    // "only card": the best price needs a loyalty program.
    if (f.card === "only" && !o.best?.program) return false;

    // Price and discount are judged on the effective condition (per-item only, never total).
    const per = eff?.per_item_cents ?? null;
    if (f.pmin != null && (per == null || per < f.pmin)) return false;
    if (f.pmax != null && (per == null || per > f.pmax)) return false;

    if (f.disc > 0 && (eff?.discount_pct ?? -1) < f.disc) return false;

    if (f.ends > 0) {
      const left = daysLeft(o, today);
      if (left == null || left < 0 || left > f.ends) return false;
    }
    return true;
  });
  return sortOffers(out, f.sort, f.card);
}

// ---- URL query <-> Filters ------------------------------------------------

function parseList(v: string | null): string[] {
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/** "1,5" / "1.50" -> 150; empty or invalid -> null. */
export function parseEuroToCents(v: string | null): number | null {
  if (v == null || v.trim() === "") return null;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

export function centsToEuroParam(c: number): string {
  return String(Math.round(c) / 100);
}

function pickNumber<T extends number>(v: string | null, allowed: readonly T[], fallback: T): T {
  const n = Number(v);
  return (allowed as readonly number[]).includes(n) ? (n as T) : fallback;
}

export function parseFilters(params: URLSearchParams): Filters {
  const sort = params.get("sort");
  const card = params.get("card");
  const when = params.get("when");
  return {
    chains: parseList(params.get("chain")).filter((c): c is ChainId =>
      (CHAIN_IDS as readonly string[]).includes(c),
    ),
    cats: parseList(params.get("cat")),
    q: params.get("q") ?? "",
    sort: (SORT_KEYS as readonly string[]).includes(sort ?? "") ? (sort as SortKey) : "discount",
    pmin: parseEuroToCents(params.get("pmin")),
    pmax: parseEuroToCents(params.get("pmax")),
    disc: pickNumber(params.get("disc"), DISC_OPTIONS, 0),
    card: card === "without" || card === "only" ? card : "all",
    when: when === "upcoming" || when === "all" ? when : "now",
    ends: pickNumber(params.get("ends"), ENDS_OPTIONS, 0),
  };
}

/** Writes only non-default values, so the URL stays short. */
export function serializeFilters(f: Filters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.chains.length) p.set("chain", f.chains.join(","));
  if (f.cats.length) p.set("cat", f.cats.join(","));
  if (f.q) p.set("q", f.q);
  if (f.sort !== DEFAULT_FILTERS.sort) p.set("sort", f.sort);
  if (f.pmin != null) p.set("pmin", centsToEuroParam(f.pmin));
  if (f.pmax != null) p.set("pmax", centsToEuroParam(f.pmax));
  if (f.disc) p.set("disc", String(f.disc));
  if (f.card !== "all") p.set("card", f.card);
  if (f.when !== "now") p.set("when", f.when);
  if (f.ends) p.set("ends", String(f.ends));
  return p;
}

/** Number of active filters (sort excluded). */
export function activeFilterCount(f: Filters): number {
  return (
    (f.chains.length ? 1 : 0) +
    (f.cats.length ? 1 : 0) +
    (f.q ? 1 : 0) +
    (f.pmin != null || f.pmax != null ? 1 : 0) +
    (f.disc ? 1 : 0) +
    (f.card !== "all" ? 1 : 0) +
    (f.when !== "now" ? 1 : 0) +
    (f.ends ? 1 : 0)
  );
}
