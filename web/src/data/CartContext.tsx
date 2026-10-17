import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  acceptPrice as acceptPriceFn,
  addOffer,
  cartCount,
  clearCart,
  clearChain as clearChainFn,
  inCartQty,
  parseCart,
  reconcile,
  removeLine,
  replaceLine,
  setCard as setCardFn,
  setQty as setQtyFn,
  EMPTY_CART,
  type CartState,
  type CartSummary,
} from "../domain/cart";
import type { ChainId, Offer } from "../domain/types";
import { track } from "../platform/analytics";
import { localKv, type LocalKv } from "../platform/localKv";
import { useCatalog } from "./CatalogContext";

export const CART_KEY = "bgpromos:cart:v1";

export interface CartApi {
  state: CartState;
  summary: CartSummary;
  count: number;
  qtyOf: (offerId: string) => number;
  add: (offer: Offer) => void;
  setQty: (offerId: string, qty: number) => void;
  remove: (offerId: string) => void;
  clear: () => void;
  clearChain: (chain: ChainId) => void;
  setCard: (chain: ChainId, has: boolean) => void;
  acceptPrice: (offer: Offer) => void;
  replace: (oldOfferId: string, offer: Offer) => void;
}

const CartCtx = createContext<CartApi | null>(null);

/** Cart state in localStorage (via the adapter), reconciled with the current catalog. */
export function CartProvider({ children, kv = localKv }: { children: ReactNode; kv?: LocalKv }) {
  const { catalog, today } = useCatalog();
  const [state, setState] = useState<CartState>(() => parseCart(kv.get(CART_KEY)));
  // Latest known cart, updated synchronously: the fallback when the storage has nothing
  // (unavailable storage / memory-only webviews) and for several actions before a re-render.
  const latest = useRef(state);

  // Another tab changed the cart.
  useEffect(
    () =>
      kv.subscribe(CART_KEY, (raw) => {
        const next = raw === undefined ? EMPTY_CART : parseCart(raw);
        latest.current = next;
        setState(next);
      }),
    [kv],
  );

  const summary = useMemo(() => reconcile(state, catalog, today), [state, catalog, today]);

  /** Read-modify-write on the freshest stored cart, persisted immediately (no lost updates across tabs). */
  const act = useCallback(
    (op: (s: CartState) => CartState) => {
      const raw = kv.get(CART_KEY);
      const base = raw === undefined ? latest.current : parseCart(raw);
      const next = op(base);
      latest.current = next;
      if (next !== base) kv.set(CART_KEY, next);
      setState(next);
    },
    [kv],
  );

  const add = useCallback(
    (offer: Offer) => {
      track("cart_add", { chain: offer.chain, category: offer.category });
      act((s) => addOffer(s, offer));
    },
    [act],
  );
  const setQty = useCallback((offerId: string, qty: number) => act((s) => setQtyFn(s, offerId, qty)), [act]);
  const remove = useCallback(
    (offerId: string) => {
      const line = latest.current.lines.find((l) => l.offerId === offerId);
      if (line) track("cart_remove", { chain: line.chain, category: line.category });
      act((s) => removeLine(s, offerId));
    },
    [act],
  );
  const clear = useCallback(() => {
    track("cart_clear", {});
    act((s) => clearCart(s));
  }, [act]);
  const clearChain = useCallback(
    (chain: ChainId) => {
      track("cart_clear", { chain });
      act((s) => clearChainFn(s, chain));
    },
    [act],
  );
  const setCard = useCallback((chain: ChainId, has: boolean) => act((s) => setCardFn(s, chain, has)), [act]);
  const acceptPrice = useCallback((offer: Offer) => act((s) => acceptPriceFn(s, offer)), [act]);
  const replace = useCallback((oldId: string, offer: Offer) => act((s) => replaceLine(s, oldId, offer)), [act]);

  const value = useMemo<CartApi>(
    () => ({
      state,
      summary,
      count: cartCount(state),
      qtyOf: (id) => inCartQty(state, id),
      add,
      setQty,
      remove,
      clear,
      clearChain,
      setCard,
      acceptPrice,
      replace,
    }),
    [state, summary, add, setQty, remove, clear, clearChain, setCard, acceptPrice, replace],
  );
  return <CartCtx.Provider value={value}>{children}</CartCtx.Provider>;
}

export function useCart(): CartApi {
  const c = useContext(CartCtx);
  if (!c) throw new Error("CartProvider missing");
  return c;
}
