import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  acceptPrice as acceptPriceFn,
  addOffer,
  cartCount,
  clearCart,
  clearChain as clearChainFn,
  inCartQty,
  gramsOf,
  isWeightLine,
  setGrams as setGramsFn,
  reconcile,
  removeLine,
  replaceLine,
  setCard as setCardFn,
  setQty as setQtyFn,
  type CartState,
  type CartSummary,
} from "../domain/cart";
import {
  activeCart,
  decodeShare,
  deleteCart,
  encodeShare,
  importShared,
  parseCarts,
  type SharedItem,
  renameCart,
  shareUrl,
  switchCart,
  type CartOrigin,
  type CartsState,
  type ImportResult,
} from "../domain/carts";
import type { ChainId, Offer } from "../domain/types";
import { track } from "../platform/analytics";
import { siteOrigin } from "../platform/env";
import { localKv, type LocalKv } from "../platform/localKv";
import { withLock } from "../platform/locks";
import { useCatalog } from "./CatalogContext";
import { useConfig } from "./ConfigContext";

/** Several lists (v2). */
export const CARTS_KEY = "bgpromos:carts:v2";
/** Old single cart; migrated into CARTS_KEY on the first load and then removed. */
export const CART_KEY_V1 = "bgpromos:cart:v1";

/** Web Lock name serializing cart read-modify-write across tabs. */
const LOCK_NAME = "bgpromos-cart";

/** One list as shown in the switcher. */
export interface CartListInfo {
  id: string;
  name: string | null;
  origin: CartOrigin;
  createdAt: string;
  count: number;
  active: boolean;
}

export interface CartApi {
  /** The active list. */
  state: CartState;
  summary: CartSummary;
  /** Item count of the active list. */
  count: number;
  qtyOf: (offerId: string) => number;
  add: (offer: Offer) => void;
  setQty: (offerId: string, qty: number) => void;
  /** Weight of a weight line in grams (0 when the offer is not in the cart or is not a weight line). */
  gramsOfOffer: (offerId: string) => number;
  /** Sets the grams of a weight line; below the minimum removes the line. */
  setGrams: (offerId: string, grams: number) => void;
  remove: (offerId: string) => void;
  clear: () => void;
  clearChain: (chain: ChainId) => void;
  setCard: (chain: ChainId, has: boolean) => void;
  acceptPrice: (offer: Offer) => void;
  replace: (oldOfferId: string, offer: Offer) => void;
  lists: CartListInfo[];
  activeId: string;
  switchList: (id: string) => void;
  deleteList: (id: string) => void;
  renameList: (id: string, name: string) => void;
  /** Absolute link to the active list (page language `lang`, default "bg"), null when it is empty. */
  shareLink: (lang?: string) => string | null;
  /** Imports a share value ("1.<id>-<qty>_...") or already decoded items; needs a loaded catalog (otherwise "nothing"). */
  importFromLink: (value: string | SharedItem[] | null | undefined) => Promise<ImportResult>;
}

const CartCtx = createContext<CartApi | null>(null);

/**
 * Per storage: true until the first import/user action of this page load, and only when neither the
 * v2 nor the v1 key existed before the very first read. A WeakMap (not a ref) so that StrictMode's
 * double render, which reads again after our first write, cannot flip it.
 */
const firstLaunchByKv = new WeakMap<LocalKv, boolean>();

/** Reads the stored lists; migrates the old single cart once (write v2, then drop v1). */
function load(kv: LocalKv): CartsState {
  const raw = kv.get<unknown>(CARTS_KEY);
  const legacy = kv.get<unknown>(CART_KEY_V1);
  if (!firstLaunchByKv.has(kv)) firstLaunchByKv.set(kv, raw === undefined && legacy === undefined);
  const state = parseCarts(raw, legacy);
  if (raw === undefined && legacy === undefined) {
    // Persist the fresh state so every tab shows the same list ids (actions target lists by id).
    kv.set(CARTS_KEY, state);
  } else if (legacy !== undefined) {
    // Drop v1 only when v2 is safely stored (or already was); a failed write keeps v1 for the next start.
    const v2Stored = raw !== undefined || kv.set(CARTS_KEY, state);
    if (v2Stored) kv.remove(CART_KEY_V1);
  }
  return state;
}

/** Cart lists in localStorage (via the adapter), the active one reconciled with the current catalog. */
export function CartProvider({ children, kv = localKv }: { children: ReactNode; kv?: LocalKv }) {
  const { catalog, today } = useCatalog();
  const config = useConfig();
  const [state, setState] = useState<CartsState>(() => load(kv));
  // Latest known state, updated synchronously: the fallback when the storage has nothing
  // (unavailable storage / memory-only webviews) and for several actions before a re-render.
  const latest = useRef(state);

  // Another tab changed the lists.
  useEffect(
    () =>
      kv.subscribe(CARTS_KEY, (raw) => {
        const next = raw === undefined ? latest.current : parseCarts(raw);
        latest.current = next;
        setState(next);
      }),
    [kv],
  );

  const active = activeCart(state);
  const cartState = active.cart;
  const summary = useMemo(() => reconcile(cartState, catalog, today), [cartState, catalog, today]);

  /**
   * Read-modify-write on the freshest stored lists, exclusive across tabs (Web Locks when available),
   * persisted immediately (no lost updates). React state is updated after the lock callback.
   */
  const act = useCallback(
    (op: (s: CartsState) => CartsState): Promise<CartsState> => {
      let out: CartsState = latest.current;
      return withLock(LOCK_NAME, () => {
        const raw = kv.get<unknown>(CARTS_KEY);
        const base = raw === undefined ? latest.current : parseCarts(raw);
        const next = op(base);
        // Any user action or import ends the "first launch" for later imports in this session.
        firstLaunchByKv.set(kv, false);
        latest.current = next;
        if (next !== base) kv.set(CARTS_KEY, next);
        out = next;
      }).then(() => {
        setState(out);
        return out;
      });
    },
    [kv],
  );
  /**
   * Operation on the list the user SEES (`listId` = activeId at render time), looked up by id in the
   * fresh stored state. If that list is gone (deleted in another tab) it is a no-op and the UI
   * simply follows the stored active list.
   */
  const actOn = useCallback(
    (listId: string, op: (c: CartState) => CartState) =>
      void act((s) => {
        const target = s.carts.find((c) => c.id === listId);
        if (!target) return s;
        const next = op(target.cart);
        if (next === target.cart) return s;
        return { ...s, carts: s.carts.map((c) => (c.id === listId ? { ...c, cart: next } : c)) };
      }),
    [act],
  );
  const shownId = active.id;

  const add = useCallback(
    (offer: Offer) => {
      track("cart_add", { chain: offer.chain, category: offer.category });
      actOn(shownId, (s) => addOffer(s, offer));
    },
    [actOn, shownId],
  );
  const setQty = useCallback(
    (offerId: string, qty: number) => actOn(shownId, (s) => setQtyFn(s, offerId, qty)),
    [actOn, shownId],
  );
  const setGrams = useCallback(
    (offerId: string, grams: number) => actOn(shownId, (s) => setGramsFn(s, offerId, grams)),
    [actOn, shownId],
  );
  const remove = useCallback(
    (offerId: string) => {
      const line = latest.current.carts.find((c) => c.id === shownId)?.cart.lines.find((l) => l.offerId === offerId);
      if (line) track("cart_remove", { chain: line.chain, category: line.category });
      actOn(shownId, (s) => removeLine(s, offerId));
    },
    [actOn, shownId],
  );
  const clear = useCallback(() => {
    track("cart_clear", {});
    actOn(shownId, (s) => clearCart(s));
  }, [actOn, shownId]);
  const clearChain = useCallback(
    (chain: ChainId) => {
      track("cart_clear", { chain });
      actOn(shownId, (s) => clearChainFn(s, chain));
    },
    [actOn, shownId],
  );
  const setCard = useCallback(
    (chain: ChainId, has: boolean) => actOn(shownId, (s) => setCardFn(s, chain, has)),
    [actOn, shownId],
  );
  const acceptPrice = useCallback((offer: Offer) => actOn(shownId, (s) => acceptPriceFn(s, offer)), [actOn, shownId]);
  const replace = useCallback(
    (oldId: string, offer: Offer) => actOn(shownId, (s) => replaceLine(s, oldId, offer)),
    [actOn, shownId],
  );

  const switchList = useCallback((id: string) => void act((s) => switchCart(s, id)), [act]);
  const deleteList = useCallback(
    (id: string) => void act((s) => (s.carts.some((c) => c.id === id) ? deleteCart(s, id) : s)),
    [act],
  );
  const renameList = useCallback((id: string, name: string) => void act((s) => renameCart(s, id, name)), [act]);

  const siteUrl = config.site_url;
  const shareLink = useCallback(
    (lang: string = "bg"): string | null => {
      const raw = kv.get<unknown>(CARTS_KEY);
      const base = raw === undefined ? latest.current : parseCarts(raw);
      // The list on screen, not whatever another tab made active.
      const shown = base.carts.find((c) => c.id === shownId) ?? activeCart(base);
      const value = encodeShare(shown.cart);
      if (!value) return null;
      track("cart_share", {});
      return shareUrl(siteUrl || siteOrigin(), lang, value);
    },
    [kv, siteUrl, shownId],
  );

  const importFromLink = useCallback(
    async (value: string | SharedItem[] | null | undefined): Promise<ImportResult> => {
      const items = Array.isArray(value) ? value : decodeShare(value);
      const holder: { result: ImportResult | null } = { result: null };
      if (catalog && items.length) {
        await act((s) => {
          holder.result = importShared(s, items, catalog, today, new Date(), firstLaunchByKv.get(kv) === true);
          return holder.result.state;
        });
      }
      const res: ImportResult = holder.result ?? {
        state: latest.current,
        cartId: latest.current.activeId,
        mode: "nothing",
        added: 0,
        missing: 0,
      };
      track("cart_import", { mode: res.mode, added: res.added, missing: res.missing });
      return res;
    },
    [act, catalog, today, kv],
  );

  const lists = useMemo<CartListInfo[]>(
    () =>
      state.carts.map((c) => ({
        id: c.id,
        name: c.name,
        origin: c.origin,
        createdAt: c.createdAt,
        count: cartCount(c.cart),
        active: c.id === active.id,
      })),
    [state.carts, active.id],
  );

  const value = useMemo<CartApi>(
    () => ({
      state: cartState,
      summary,
      count: cartCount(cartState),
      qtyOf: (id) => inCartQty(cartState, id),
      gramsOfOffer: (id) => {
        const l = cartState.lines.find((x) => x.offerId === id);
        return l && isWeightLine(l) ? gramsOf(l) : 0;
      },
      add,
      setQty,
      setGrams,
      remove,
      clear,
      clearChain,
      setCard,
      acceptPrice,
      replace,
      lists,
      activeId: active.id,
      switchList,
      deleteList,
      renameList,
      shareLink,
      importFromLink,
    }),
    [
      cartState,
      summary,
      add,
      setQty,
      setGrams,
      remove,
      clear,
      clearChain,
      setCard,
      acceptPrice,
      replace,
      lists,
      active.id,
      switchList,
      deleteList,
      renameList,
      shareLink,
      importFromLink,
    ],
  );
  return <CartCtx.Provider value={value}>{children}</CartCtx.Provider>;
}

export function useCart(): CartApi {
  const c = useContext(CartCtx);
  if (!c) throw new Error("CartProvider missing");
  return c;
}
