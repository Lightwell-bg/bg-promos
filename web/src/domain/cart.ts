// "Моя корзина" - a shopping list (not an order). Pure logic: no storage, no React.
//
// Price rules (money = integer EUR cents):
// - Loyalty-program prices count by default (owner's decision 2026-10-17: "с картой
//   лояльности считать"); the user can switch a chain's card off (CartState.cards[chain] = false).
// - A multibuy condition's total_cents is the price of min_qty units. For qty units the cost
//   is floor(qty / k) bundles at the deal price plus the remainder at the cheapest available
//   single-unit price (promo/loyalty with min_qty 1, else regular). If no single-unit price is
//   known the remainder uses the deal's per-item price and the line is marked approximate.
// - Ended offers (missing from the catalog or valid_to < today) are NOT counted in totals.
// - Upcoming offers (valid_from > today) are counted and flagged.
import { status } from "./dates";
import type { Catalog, ChainId, Offer, PriceCondition, Program } from "./types";
import { CHAIN_IDS } from "./types";

export const CART_VERSION = 1;
export const MAX_QTY = 99;

/** Loyalty programs covered by "I have a card" for each chain. */
export const CHAIN_PROGRAMS: Record<ChainId, readonly Program[]> = {
  lidl: ["lidl_plus"],
  kaufland: ["kaufland_card"],
  billa: ["billa_card", "billa_app"],
};

export interface CartSnapshot {
  prices: PriceCondition[];
  regular_cents: number | null;
  valid_from: string | null;
  valid_to: string | null;
}

export interface CartLine {
  offerId: string;
  chain: ChainId;
  productRef: string;
  name: string;
  imageUrl: string | null;
  unitText: string | null;
  category: string;
  qty: number;
  addedAt: string;
  /** Prices as seen when the line was added (or last accepted); used to detect changes. */
  snapshot: CartSnapshot;
}

export interface CartState {
  version: typeof CART_VERSION;
  lines: CartLine[];
  /** Loyalty card per chain. Missing = has the card (default); false = no card. */
  cards: Partial<Record<ChainId, boolean>>;
}

export const EMPTY_CART: CartState = { version: CART_VERSION, lines: [], cards: {} };

// ---------------------------------------------------------------- pricing

export interface LinePrice {
  /** Cost of qty units; null when no price is available to this user (e.g. card-only). */
  totalCents: number | null;
  /** Condition that gives the cheapest cost (null when regular price only or none). */
  condition: PriceCondition | null;
  /** true when part of the cost is estimated (remainder of a multibuy without a unit price). */
  approximate: boolean;
  /** Multibuy hint: units to add to complete the next bundle of the cheapest deal. */
  addForDeal: { add: number; minQty: number } | null;
  /** A card price exists that the user cannot use (no card). */
  cardOnly: boolean;
}

function usable(c: PriceCondition, chain: ChainId, cards: CartState["cards"]): boolean {
  if (c.kind === "regular") return false;
  if (!c.program) return true;
  return hasCard(cards, chain) && CHAIN_PROGRAMS[chain].includes(c.program);
}

/** Card prices are used unless the user switched this chain's card off. */
export function hasCard(cards: CartState["cards"], chain: ChainId): boolean {
  return cards[chain] !== false;
}

/** Cost of `qty` units from a price list, using only conditions this user can get. */
export function priceLine(
  prices: PriceCondition[],
  regularCents: number | null,
  qty: number,
  chain: ChainId,
  cards: CartState["cards"],
): LinePrice {
  const q = Math.max(0, Math.floor(qty));
  const avail = prices.filter((c) => usable(c, chain, cards));
  const cardOnly = prices.some((c) => c.kind !== "regular" && !usable(c, chain, cards));
  const singles = avail.filter((c) => c.min_qty <= 1);
  const deals = avail.filter((c) => c.min_qty > 1);

  // Cheapest single unit: the regular price competes with single-unit promos (a card price can be
  // higher than the regular one). `unitCond` is null when the regular price wins.
  let unit: number | null = regularCents;
  let unitCond: PriceCondition | null = null;
  for (const c of singles) {
    if (unit === null || c.total_cents < unit) {
      unit = c.total_cents;
      unitCond = c;
    }
  }

  // Exact minimum cost for n units combining single units and any number of bundles of any
  // available multibuy (unbounded knapsack, n <= MAX_QTY). cost[n] = Infinity when n cannot be
  // composed exactly (no unit price and no bundle combination).
  const INF = Number.POSITIVE_INFINITY;
  const cost: number[] = new Array(q + 1).fill(INF);
  const via: (PriceCondition | "unit" | null)[] = new Array(q + 1).fill(null);
  cost[0] = 0;
  for (let n = 1; n <= q; n++) {
    if (unit !== null && cost[n - 1] + unit < cost[n]) {
      cost[n] = cost[n - 1] + unit;
      via[n] = "unit";
    }
    for (const d of deals) {
      if (n >= d.min_qty && cost[n - d.min_qty] + d.total_cents < cost[n]) {
        cost[n] = cost[n - d.min_qty] + d.total_cents;
        via[n] = d;
      }
    }
  }

  // Which multibuy carries most units in the optimal plan (shown as the line's condition).
  const unitsByDeal = new Map<PriceCondition, number>();
  const trace = (n: number) => {
    while (n > 0 && via[n]) {
      const step = via[n];
      if (step === "unit") n -= 1;
      else if (step) {
        unitsByDeal.set(step, (unitsByDeal.get(step) ?? 0) + step.min_qty);
        n -= step.min_qty;
      }
    }
  };

  const cheapestDeal = [...deals].sort((a, b) => a.per_item_cents - b.per_item_cents)[0];
  let addForDeal: LinePrice["addForDeal"] = null;
  if (cheapestDeal && q > 0 && q % cheapestDeal.min_qty !== 0 && (unit === null || cheapestDeal.per_item_cents < unit)) {
    addForDeal = { add: cheapestDeal.min_qty - (q % cheapestDeal.min_qty), minQty: cheapestDeal.min_qty };
  }

  if (q === 0) return { totalCents: 0, condition: unitCond, approximate: false, addForDeal: null, cardOnly };

  let total: number;
  let approximate = false;
  if (cost[q] < INF) {
    total = cost[q];
    trace(q);
  } else if (cheapestDeal) {
    // No unit price: price the largest exactly composable part, estimate the rest per item.
    let n = q;
    while (n > 0 && cost[n] === INF) n--;
    total = cost[n] + (q - n) * cheapestDeal.per_item_cents;
    approximate = true;
    trace(n);
    if (n === 0) unitsByDeal.set(cheapestDeal, q);
  } else {
    return { totalCents: null, condition: null, approximate: false, addForDeal, cardOnly };
  }

  let condition: PriceCondition | null = unitCond;
  let most = 0;
  for (const [d, units] of unitsByDeal) {
    if (units > most) {
      most = units;
      condition = d;
    }
  }
  return { totalCents: total, condition, approximate, addForDeal, cardOnly };
}

// ---------------------------------------------------------------- reconciliation

export type LineStatus = "ok" | "price_changed" | "upcoming" | "ended" | "unknown";

export interface ReconciledLine {
  line: CartLine;
  status: LineStatus;
  /** Current offer when found (also for upcoming). */
  offer: Offer | null;
  /** For ended lines: a current/upcoming offer of the same product in the same chain. */
  replacement: Offer | null;
  price: LinePrice;
  /** The user-relevant cost differs from the snapshot (independent of status: an upcoming
   *  offer can also change its price). */
  priceChanged: boolean;
  /** Previous cost for qty when the price changed (from the snapshot). */
  previousTotalCents: number | null;
  /** Counted in the chain subtotal and the grand total. */
  counted: boolean;
}

export interface ChainGroup {
  chain: ChainId;
  lines: ReconciledLine[];
  subtotalCents: number;
  /** Units counted in subtotal. */
  items: number;
  approximate: boolean;
  /** Lines not counted (ended or no price available). */
  excluded: number;
}

export interface CartSummary {
  groups: ChainGroup[];
  totalCents: number;
  items: number;
  approximate: boolean;
  excluded: number;
  changed: number;
}

function snapshotOf(offer: Offer): CartSnapshot {
  return {
    prices: offer.prices.map((p) => ({ ...p })),
    regular_cents: offer.regular_cents,
    valid_from: offer.valid_from,
    valid_to: offer.valid_to,
  };
}

/** Compare the user-relevant cost of one unit-set, not raw fields (avoids noise). */
function samePrices(a: CartSnapshot, offer: Offer, qty: number, chain: ChainId, cards: CartState["cards"]): boolean {
  const before = priceLine(a.prices, a.regular_cents, qty, chain, cards).totalCents;
  const now = priceLine(offer.prices, offer.regular_cents, qty, chain, cards).totalCents;
  return before === now;
}

export function reconcile(state: CartState, catalog: Catalog | null, today: string): CartSummary {
  const byId = new Map<string, Offer>();
  const byProduct = new Map<string, Offer[]>();
  for (const o of catalog?.offers ?? []) {
    byId.set(o.id, o);
    const key = `${o.chain}|${o.product_ref}`;
    const list = byProduct.get(key);
    if (list) list.push(o);
    else byProduct.set(key, [o]);
  }

  const reconciled: ReconciledLine[] = state.lines.map((line) => {
    const cards = state.cards;
    if (!catalog) {
      const price = priceLine(line.snapshot.prices, line.snapshot.regular_cents, line.qty, line.chain, cards);
      const ended = line.snapshot.valid_to !== null && line.snapshot.valid_to < today;
      return {
        line,
        status: ended ? "ended" : "unknown",
        offer: null,
        replacement: null,
        price,
        priceChanged: false,
        previousTotalCents: null,
        counted: !ended && price.totalCents !== null,
      };
    }
    const offer = byId.get(line.offerId) ?? null;
    const st = offer ? status(offer, today) : "ended";
    if (!offer || st === "ended") {
      const candidates = (byProduct.get(`${line.chain}|${line.productRef}`) ?? []).filter(
        (o) => o.id !== line.offerId && status(o, today) !== "ended",
      );
      // prefer an active offer, then the earliest upcoming one
      candidates.sort((a, b) => {
        const sa = status(a, today) === "active" ? 0 : 1;
        const sb = status(b, today) === "active" ? 0 : 1;
        return sa - sb || (a.valid_from ?? "").localeCompare(b.valid_from ?? "");
      });
      const price = priceLine(line.snapshot.prices, line.snapshot.regular_cents, line.qty, line.chain, cards);
      return {
        line,
        status: "ended",
        offer: null,
        replacement: candidates[0] ?? null,
        price,
        priceChanged: false,
        previousTotalCents: null,
        counted: false,
      };
    }
    const price = priceLine(offer.prices, offer.regular_cents, line.qty, line.chain, cards);
    const changed = !samePrices(line.snapshot, offer, line.qty, line.chain, cards);
    const previousTotalCents = changed
      ? priceLine(line.snapshot.prices, line.snapshot.regular_cents, line.qty, line.chain, cards).totalCents
      : null;
    return {
      line,
      status: st === "upcoming" ? "upcoming" : changed ? "price_changed" : "ok",
      offer,
      replacement: null,
      price,
      priceChanged: changed,
      previousTotalCents,
      counted: price.totalCents !== null,
    };
  });

  const groups: ChainGroup[] = [];
  for (const chain of CHAIN_IDS) {
    const lines = reconciled.filter((r) => r.line.chain === chain);
    if (!lines.length) continue;
    const counted = lines.filter((r) => r.counted);
    groups.push({
      chain,
      lines,
      subtotalCents: counted.reduce((s, r) => s + (r.price.totalCents ?? 0), 0),
      items: counted.reduce((s, r) => s + r.line.qty, 0),
      approximate: counted.some((r) => r.price.approximate),
      excluded: lines.length - counted.length,
    });
  }
  return {
    groups,
    totalCents: groups.reduce((s, g) => s + g.subtotalCents, 0),
    items: groups.reduce((s, g) => s + g.items, 0),
    approximate: groups.some((g) => g.approximate),
    excluded: groups.reduce((s, g) => s + g.excluded, 0),
    changed: reconciled.filter((r) => r.priceChanged).length,
  };
}

// ---------------------------------------------------------------- state transitions (immutable)

function clampQty(q: number): number {
  return Math.min(MAX_QTY, Math.max(1, Math.floor(q)));
}

export function addOffer(state: CartState, offer: Offer, now: Date = new Date(), qty = 1): CartState {
  const existing = state.lines.find((l) => l.offerId === offer.id);
  if (existing) return setQty(state, offer.id, existing.qty + qty);
  const line: CartLine = {
    offerId: offer.id,
    chain: offer.chain,
    productRef: offer.product_ref,
    name: offer.name,
    imageUrl: offer.image_url,
    unitText: offer.unit_text,
    category: offer.category,
    qty: clampQty(qty),
    addedAt: now.toISOString(),
    snapshot: snapshotOf(offer),
  };
  return { ...state, lines: [...state.lines, line] };
}

export function setQty(state: CartState, offerId: string, qty: number): CartState {
  if (qty < 1) return removeLine(state, offerId);
  return { ...state, lines: state.lines.map((l) => (l.offerId === offerId ? { ...l, qty: clampQty(qty) } : l)) };
}

export function removeLine(state: CartState, offerId: string): CartState {
  return { ...state, lines: state.lines.filter((l) => l.offerId !== offerId) };
}

export function clearCart(state: CartState): CartState {
  return { ...state, lines: [] };
}

export function clearChain(state: CartState, chain: ChainId): CartState {
  return { ...state, lines: state.lines.filter((l) => l.chain !== chain) };
}

export function setCard(state: CartState, chain: ChainId, has: boolean): CartState {
  return { ...state, cards: { ...state.cards, [chain]: has } };
}

/** User accepted the new price: refresh the snapshot so the "changed" notice disappears. */
export function acceptPrice(state: CartState, offer: Offer): CartState {
  return {
    ...state,
    lines: state.lines.map((l) => (l.offerId === offer.id ? { ...l, snapshot: snapshotOf(offer), name: offer.name } : l)),
  };
}

/** Swap an ended line for the replacement offer, keeping the quantity (merges if present). */
export function replaceLine(state: CartState, oldOfferId: string, offer: Offer, now: Date = new Date()): CartState {
  const old = state.lines.find((l) => l.offerId === oldOfferId);
  if (!old) return state;
  return addOffer(removeLine(state, oldOfferId), offer, now, old.qty);
}

export function cartCount(state: CartState): number {
  return state.lines.reduce((s, l) => s + l.qty, 0);
}

export function inCartQty(state: CartState, offerId: string): number {
  return state.lines.find((l) => l.offerId === offerId)?.qty ?? 0;
}

// ---------------------------------------------------------------- persistence format

const KINDS: readonly string[] = ["regular", "promo", "loyalty", "multibuy"];
const PROGRAMS: readonly string[] = ["lidl_plus", "kaufland_card", "billa_card", "billa_app"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isCents = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 10_000_000;
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const isDateOrNull = (v: unknown): v is string | null => v === null || (typeof v === "string" && DATE_RE.test(v));

function parseCondition(raw: unknown): PriceCondition | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.kind !== "string" || !KINDS.includes(c.kind)) return null;
  if (!(c.program === null || (typeof c.program === "string" && PROGRAMS.includes(c.program)))) return null;
  if (typeof c.min_qty !== "number" || !Number.isInteger(c.min_qty) || c.min_qty < 1 || c.min_qty > MAX_QTY) return null;
  // total is integer cents; the per-item rate may be fractional (e.g. 100 cents for 3 units)
  if (!isCents(c.total_cents)) return null;
  if (typeof c.per_item_cents !== "number" || !Number.isFinite(c.per_item_cents) || c.per_item_cents < 0) return null;
  if (!(c.discount_pct === null || (typeof c.discount_pct === "number" && Number.isFinite(c.discount_pct)))) return null;
  if (!isStrOrNull(c.text)) return null;
  return {
    kind: c.kind as PriceCondition["kind"],
    program: (c.program as Program | null) ?? null,
    min_qty: c.min_qty,
    total_cents: c.total_cents,
    per_item_cents: c.per_item_cents,
    discount_pct: (c.discount_pct as number | null) ?? null,
    text: (c.text as string | null) ?? null,
  };
}

function parseLine(raw: unknown): CartLine | null {
  if (!raw || typeof raw !== "object") return null;
  const l = raw as Record<string, unknown>;
  if (typeof l.offerId !== "string" || !l.offerId) return null;
  if (typeof l.chain !== "string" || !(CHAIN_IDS as readonly string[]).includes(l.chain)) return null;
  if (typeof l.productRef !== "string" || typeof l.name !== "string" || typeof l.category !== "string") return null;
  if (!isStrOrNull(l.imageUrl) || !isStrOrNull(l.unitText) || typeof l.addedAt !== "string") return null;
  if (typeof l.qty !== "number" || !Number.isFinite(l.qty) || l.qty < 1) return null;
  const s = l.snapshot as Record<string, unknown> | null;
  if (!s || typeof s !== "object" || !Array.isArray(s.prices)) return null;
  if (!(s.regular_cents === null || isCents(s.regular_cents))) return null;
  if (!isDateOrNull(s.valid_from) || !isDateOrNull(s.valid_to)) return null;
  const prices: PriceCondition[] = [];
  for (const p of s.prices) {
    const c = parseCondition(p);
    if (!c) return null; // a corrupted condition makes the whole line untrustworthy
    prices.push(c);
  }
  return {
    offerId: l.offerId,
    chain: l.chain as ChainId,
    productRef: l.productRef,
    name: l.name,
    imageUrl: l.imageUrl as string | null,
    unitText: l.unitText as string | null,
    category: l.category,
    qty: clampQty(l.qty),
    addedAt: l.addedAt,
    snapshot: {
      prices,
      regular_cents: s.regular_cents as number | null,
      valid_from: s.valid_from as string | null,
      valid_to: s.valid_to as string | null,
    },
  };
}

/** Parse untrusted stored JSON: drops malformed lines, merges duplicate offerIds (sum qty). */
export function parseCart(raw: unknown): CartState {
  if (!raw || typeof raw !== "object") return EMPTY_CART;
  const r = raw as Record<string, unknown>;
  if (r.version !== CART_VERSION || !Array.isArray(r.lines)) return EMPTY_CART;
  const byId = new Map<string, CartLine>();
  for (const item of r.lines) {
    const line = parseLine(item);
    if (!line) continue;
    const prev = byId.get(line.offerId);
    byId.set(line.offerId, prev ? { ...prev, qty: clampQty(prev.qty + line.qty) } : line);
  }
  const cards: CartState["cards"] = {};
  if (r.cards && typeof r.cards === "object") {
    // only an explicit "no card" is stored; anything else means the default (has card)
    for (const c of CHAIN_IDS) if ((r.cards as Record<string, unknown>)[c] === false) cards[c] = false;
  }
  return { version: CART_VERSION, lines: [...byId.values()], cards };
}
