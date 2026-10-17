// Several shopping lists ("корзины") and sharing one by link. Pure logic, no storage/React.
//
// Sharing: the link carries only offer ids and quantities in the URL fragment
// (https://<site>/<lang>/cart/import#c=1.<id>-<qty>_<id>-<qty>...). The fragment is never sent
// to the server or analytics. The recipient rebuilds the list from its own current catalog,
// so prices/snapshots are always the recipient's, never trusted from the link.
//
// Import rule (owner, 2026-10-17): if the recipient's active list is empty it receives the
// items; otherwise a new list marked origin "shared" is created and made active. Opening the
// same link again switches to the list it created instead of creating another copy.
import {
  addOffer,
  EMPTY_CART,
  gramsOf,
  isWeightLine,
  parseCart,
  WEIGHT_MAX,
  WEIGHT_MIN,
  type CartLine,
  type CartState,
} from "./cart";
import { status } from "./dates";
import type { Catalog, Offer } from "./types";

export const CARTS_VERSION = 2;
export const MAX_CARTS = 10;
/** A list longer than this cannot be shared (the UI says so); ~15 URL chars per line. */
export const MAX_SHARED_LINES = 300;
const ID_RE = /^[0-9a-f]{12}$/;

export type CartOrigin = "own" | "shared";

export interface StoredCart {
  id: string;
  /** User-visible name; null = default label derived from origin/createdAt by the UI. */
  name: string | null;
  origin: CartOrigin;
  createdAt: string;
  /** Fingerprint of the share link that created this list (dedupe on reopen). */
  importKey: string | null;
  cart: CartState;
}

export interface CartsState {
  version: typeof CARTS_VERSION;
  activeId: string;
  carts: StoredCart[];
}

function newId(now: Date, salt: number): string {
  return `c${now.getTime().toString(36)}${salt.toString(36)}`;
}

export function initialCarts(now: Date = new Date(), cart: CartState = EMPTY_CART): CartsState {
  const id = newId(now, 0);
  return {
    version: CARTS_VERSION,
    activeId: id,
    carts: [{ id, name: null, origin: "own", createdAt: now.toISOString(), importKey: null, cart }],
  };
}

export function activeCart(s: CartsState): StoredCart {
  return s.carts.find((c) => c.id === s.activeId) ?? s.carts[0];
}

/** Apply a CartState operation to the active list. */
export function updateActive(s: CartsState, op: (c: CartState) => CartState): CartsState {
  const active = activeCart(s);
  const next = op(active.cart);
  if (next === active.cart) return s;
  return { ...s, carts: s.carts.map((c) => (c.id === active.id ? { ...c, cart: next } : c)) };
}

export function switchCart(s: CartsState, id: string): CartsState {
  return s.carts.some((c) => c.id === id) ? { ...s, activeId: id } : s;
}

/** Delete a list; the last list is emptied instead (there is always one). */
export function deleteCart(s: CartsState, id: string, now: Date = new Date()): CartsState {
  const rest = s.carts.filter((c) => c.id !== id);
  if (!rest.length) return initialCarts(now);
  const activeId = s.activeId === id ? rest[0].id : s.activeId;
  return { ...s, activeId, carts: rest };
}

export function renameCart(s: CartsState, id: string, name: string): CartsState {
  const clean = name.replace(/\s+/g, " ").trim().slice(0, 40);
  return { ...s, carts: s.carts.map((c) => (c.id === id ? { ...c, name: clean || null } : c)) };
}

// ---------------------------------------------------------------- share link codec

export interface SharedItem {
  offerId: string;
  qty: number;
  /** Weight lines: grams ("-g350" in links). Absent = pieces (or whole kg in old links). */
  grams?: number;
}

/** "-<qty>" for pieces, "-g<grams>" for weight lines; "" for a single piece when allowed. */
function amountSuffix(l: CartLine, omitOne: boolean): string {
  if (isWeightLine(l)) return `-g${gramsOf(l)}`;
  const q = Math.min(99, Math.max(1, l.qty));
  return omitOne && q === 1 ? "" : `-${q}`;
}

const AMOUNT_RE = /^([0-9a-f]{12})(?:-(?:(\d{1,2})|g(\d{3,5})))?$/;

/** Parse one "<id>[-<qty>|-g<grams>]" part; null when invalid. */
function parseItem(part: string, defaultQty: number | null): SharedItem | null {
  const m = AMOUNT_RE.exec(part);
  if (!m) return null;
  if (m[3] !== undefined) {
    const g = Number(m[3]);
    return g >= WEIGHT_MIN && g <= WEIGHT_MAX ? { offerId: m[1], qty: 1, grams: g } : null;
  }
  const qty = m[2] === undefined ? defaultQty : Number(m[2]);
  return qty && qty >= 1 ? { offerId: m[1], qty } : null;
}

function mergeItems(parts: string[], defaultQty: number | null, limit: number): SharedItem[] {
  const merged = new Map<string, SharedItem>();
  for (const part of parts) {
    const it = parseItem(part, defaultQty);
    if (!it) continue;
    const prev = merged.get(it.offerId);
    if (!prev) merged.set(it.offerId, it);
    else if (it.grams !== undefined || prev.grams !== undefined)
      merged.set(it.offerId, { offerId: it.offerId, qty: 1, grams: Math.min(WEIGHT_MAX, (prev.grams ?? 0) + (it.grams ?? 0)) });
    else merged.set(it.offerId, { offerId: it.offerId, qty: Math.min(99, prev.qty + it.qty) });
    if (merged.size >= limit) break;
  }
  return [...merged.values()];
}

/** Whether the list can be shared without dropping lines. */
export function canShare(cart: CartState): "ok" | "empty" | "too_many" {
  const n = cart.lines.filter((l) => ID_RE.test(l.offerId)).length;
  if (!n) return "empty";
  return n > MAX_SHARED_LINES ? "too_many" : "ok";
}

/** Fragment value ("1.<id>-<qty>_..."); null when empty or too long (never truncates silently). */
export function encodeShare(cart: CartState): string | null {
  if (canShare(cart) !== "ok") return null;
  const items = cart.lines.filter((l) => ID_RE.test(l.offerId));
  return "1." + items.map((l) => `${l.offerId}${amountSuffix(l, false)}`).join("_");
}

/** Parse an untrusted fragment value; invalid parts are skipped, duplicates merged. */
export function decodeShare(value: string | null | undefined): SharedItem[] {
  if (!value) return [];
  const v = value.trim();
  if (!v.startsWith("1.") || v.length > 20 * MAX_SHARED_LINES + 8) return [];
  // web form always carries an amount: "<id>-<qty>" or "<id>-g<grams>"
  return mergeItems(v.slice(2).split("_"), null, MAX_SHARED_LINES);
}

/** Read the share value from a location hash like "#c=1.abc...". */
export function shareFromHash(hash: string): string | null {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  for (const kv of h.split("&")) {
    const [k, ...rest] = kv.split("=");
    if (k === "c") return decodeURIComponent(rest.join("="));
  }
  return null;
}

// ---------------------------------------------------------------- Telegram Mini App link
//
// https://t.me/<bot>?startapp=<param> opens the bot's main Mini App directly; Telegram passes
// <param> to the page as ?tgWebAppStartParam=. Allowed: [A-Za-z0-9_-], at most 512 chars.
// Format: "c1" + "_<id>" (qty 1) or "_<id>-<qty>" per line.
export const START_PARAM_MAX = 512;
const START_PARAM_RE = /^[A-Za-z0-9_-]{1,512}$/;

/** startapp value for the list, or null when empty or longer than Telegram allows. */
export function encodeStartParam(cart: CartState): string | null {
  const items = cart.lines.filter((l) => ID_RE.test(l.offerId));
  if (!items.length) return null;
  const p = "c1" + items.map((l) => `_${l.offerId}${amountSuffix(l, true)}`).join("");
  return p.length <= START_PARAM_MAX ? p : null;
}

/** Parse an untrusted startapp value ("c1_<id>[-<qty>]..."); invalid parts skipped, duplicates merged. */
export function decodeStartParam(param: string | null | undefined): SharedItem[] {
  if (!param || !START_PARAM_RE.test(param) || !param.startsWith("c1_")) return [];
  // startapp form: a bare "<id>" means 1 piece
  return mergeItems(param.slice(3).split("_"), 1, MAX_SHARED_LINES);
}

export function telegramStartLink(botUsername: string, param: string): string {
  return `https://t.me/${botUsername.replace(/^@/, "")}?startapp=${param}`;
}

export function shareUrl(siteOrigin: string, lang: string, value: string): string {
  return `${siteOrigin.replace(/\/+$/, "")}/${lang}/cart/import#c=${value}`;
}

/** Order-insensitive fingerprint of a shared list (FNV-1a over the sorted items). */
export function importKeyOf(items: SharedItem[]): string {
  const s = [...items]
    .sort((a, b) => a.offerId.localeCompare(b.offerId))
    .map((i) => (i.grams !== undefined ? `${i.offerId}-g${i.grams}` : `${i.offerId}-${i.qty}`))
    .join("_");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// ---------------------------------------------------------------- import

export interface ImportResult {
  state: CartsState;
  cartId: string;
  /** "filled" = put into the empty active list, "created" = new list, "existing" = link already imported. */
  mode: "filled" | "created" | "existing" | "nothing";
  added: number;
  /** Items whose offer is unknown or already ended in the recipient's catalog. */
  missing: number;
}

/**
 * `firstLaunch`: true only when this device had no stored lists at all before this session
 * (owner rule 2026-10-17): then the shared list becomes the only list. Any earlier use of the
 * app - even with an empty list - keeps the user's list and adds a separate "shared" one.
 */
export function importShared(
  s: CartsState,
  items: SharedItem[],
  catalog: Catalog,
  today: string,
  now: Date = new Date(),
  firstLaunch = false,
): ImportResult {
  const key = importKeyOf(items);
  const existing = s.carts.find((c) => c.importKey === key);
  if (existing) {
    return { state: switchCart(s, existing.id), cartId: existing.id, mode: "existing", added: 0, missing: 0 };
  }
  const byId = new Map<string, Offer>(catalog.offers.map((o) => [o.id, o]));
  let cart: CartState = { ...EMPTY_CART, cards: {} };
  let added = 0;
  let missing = 0;
  for (const it of items) {
    const offer = byId.get(it.offerId);
    if (!offer || status(offer, today) === "ended") {
      missing++;
      continue;
    }
    // old links carried whole kilograms as a plain quantity for weight offers
    const weight = offer.sale_unit === "kg" || offer.sale_unit === "l";
    const grams = it.grams ?? (weight ? it.qty * 1000 : undefined);
    cart = addOffer(cart, offer, now, it.qty, grams);
    added++;
  }
  if (!added) return { state: s, cartId: s.activeId, mode: "nothing", added: 0, missing };

  const active = activeCart(s);
  if (firstLaunch && s.carts.length === 1 && active.cart.lines.length === 0) {
    const carts = s.carts.map((c) =>
      c.id === active.id ? { ...c, importKey: key, cart: { ...cart, cards: c.cart.cards } } : c,
    );
    return { state: { ...s, carts }, cartId: active.id, mode: "filled", added, missing };
  }
  const id = newId(now, s.carts.length + 1);
  const created: StoredCart = { id, name: null, origin: "shared", createdAt: now.toISOString(), importKey: key, cart };
  // Keep at most MAX_CARTS lists: drop the oldest non-active shared list first.
  let carts = [...s.carts, created];
  while (carts.length > MAX_CARTS) {
    const victim = carts.find((c) => c.id !== id && c.id !== s.activeId && c.origin === "shared") ??
      carts.find((c) => c.id !== id && c.id !== s.activeId);
    if (!victim) break;
    carts = carts.filter((c) => c !== victim);
  }
  return { state: { ...s, activeId: id, carts }, cartId: id, mode: "created", added, missing };
}

// ---------------------------------------------------------------- persistence

/** Parse stored v2 state; falls back to migrating a v1 single cart; never throws. */
export function parseCarts(raw: unknown, legacyV1: unknown = undefined, now: Date = new Date()): CartsState {
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (r.version === CARTS_VERSION && Array.isArray(r.carts)) {
      const carts: StoredCart[] = [];
      const seen = new Set<string>();
      for (const item of r.carts) {
        if (!item || typeof item !== "object") continue;
        const c = item as Record<string, unknown>;
        if (typeof c.id !== "string" || !c.id || seen.has(c.id)) continue;
        if (c.origin !== "own" && c.origin !== "shared") continue;
        if (typeof c.createdAt !== "string") continue;
        const name = typeof c.name === "string" ? c.name.slice(0, 40) : null;
        const importKey = typeof c.importKey === "string" ? c.importKey.slice(0, 32) : null;
        seen.add(c.id);
        carts.push({ id: c.id, name, origin: c.origin, createdAt: c.createdAt, importKey, cart: parseCart(c.cart) });
        if (carts.length >= MAX_CARTS) break;
      }
      if (carts.length) {
        const activeId = typeof r.activeId === "string" && seen.has(r.activeId) ? r.activeId : carts[0].id;
        return { version: CARTS_VERSION, activeId, carts };
      }
    }
  }
  return initialCarts(now, parseCart(legacyV1));
}
