import { describe, expect, it } from "vitest";
import { IDS, offerById, sampleCatalog, SAMPLE_TODAY } from "../__fixtures__";
import {
  acceptPrice,
  addOffer,
  cartCount,
  clearCart,
  clearChain,
  EMPTY_CART,
  inCartQty,
  MAX_QTY,
  parseCart,
  priceLine,
  reconcile,
  removeLine,
  replaceLine,
  setCard,
  setQty,
  type CartState,
} from "./cart";
import type { Catalog, Offer, PriceCondition, PriceKind, Program } from "./types";

const NOW = new Date("2026-10-17T08:00:00Z");

function pc(kind: PriceKind, program: Program | null, minQty: number, total: number): PriceCondition {
  return {
    kind,
    program,
    min_qty: minQty,
    total_cents: total,
    per_item_cents: Math.round(total / minQty),
    discount_pct: null,
    text: null,
  };
}

const catalog = sampleCatalog();
const offer = (id: string): Offer => offerById(catalog, id);

function withOffers(offers: Offer[]): Catalog {
  return { ...sampleCatalog(), offers };
}

function cartOf(...entries: Array<[Offer, number]>): CartState {
  return entries.reduce((s, [o, q]) => addOffer(s, o, NOW, q), EMPTY_CART);
}

describe("priceLine", () => {
  it("promo single: qty x promo price", () => {
    const r = priceLine([pc("promo", null, 1, 159), pc("regular", null, 1, 199)], 199, 3, "lidl", {});
    expect(r.totalCents).toBe(477);
    expect(r.condition?.kind).toBe("promo");
    expect(r.approximate).toBe(false);
    expect(r.addForDeal).toBeNull();
    expect(r.cardOnly).toBe(false);
  });

  it("loyalty price is excluded when the card is switched off and used with it", () => {
    const prices = [pc("loyalty", "lidl_plus", 1, 99), pc("regular", null, 1, 159)];
    const without = priceLine(prices, 159, 2, "lidl", { lidl: false });
    expect(without.totalCents).toBe(318);
    expect(without.cardOnly).toBe(true);
    const withCard = priceLine(prices, 159, 2, "lidl", { lidl: true });
    expect(withCard.totalCents).toBe(198);
    expect(withCard.condition?.program).toBe("lidl_plus");
    expect(withCard.cardOnly).toBe(false);
  });

  it("by default (no explicit choice) the card price is used", () => {
    const prices = [pc("loyalty", "lidl_plus", 1, 99), pc("regular", null, 1, 159)];
    const r = priceLine(prices, 159, 2, "lidl", {});
    expect(r.totalCents).toBe(198);
    expect(r.condition?.program).toBe("lidl_plus");
    expect(r.cardOnly).toBe(false);
  });

  it("the BILLA card covers billa_app prices by default; switching it off or another chain's card does not matter", () => {
    const prices = [pc("loyalty", "billa_app", 1, 500), pc("regular", null, 1, 700)];
    expect(priceLine(prices, 700, 1, "billa", {}).totalCents).toBe(500);
    expect(priceLine(prices, 700, 1, "billa", { billa: true }).totalCents).toBe(500);
    expect(priceLine(prices, 700, 1, "billa", { lidl: false, kaufland: false }).totalCents).toBe(500);
    expect(priceLine(prices, 700, 1, "billa", { billa: false }).totalCents).toBe(700);
  });

  it("multibuy 1+1 (199 per 2): qty 1 = regular price + hint, qty 2 = deal, qty 3 = deal + regular", () => {
    const prices = [pc("multibuy", null, 2, 199), pc("regular", null, 1, 199)];
    const one = priceLine(prices, 199, 1, "kaufland", {});
    expect(one.totalCents).toBe(199);
    expect(one.addForDeal).toEqual({ add: 1, minQty: 2 });
    const two = priceLine(prices, 199, 2, "kaufland", {});
    expect(two.totalCents).toBe(199);
    expect(two.addForDeal).toBeNull();
    expect(two.condition?.kind).toBe("multibuy");
    const three = priceLine(prices, 199, 3, "kaufland", {});
    expect(three.totalCents).toBe(398);
    expect(three.approximate).toBe(false);
    expect(three.addForDeal).toEqual({ add: 1, minQty: 2 });
  });

  it("multibuy without any single-unit price: remainder estimated per item and approximate", () => {
    const prices = [pc("multibuy", null, 2, 199)];
    const r = priceLine(prices, null, 3, "kaufland", {});
    expect(r.totalCents).toBe(199 + 100);
    expect(r.approximate).toBe(true);
    expect(priceLine(prices, null, 2, "kaufland", {}).approximate).toBe(false);
  });

  it("a single loyalty price higher than the regular one loses: regular wins, no condition", () => {
    const r = priceLine([pc("loyalty", "lidl_plus", 1, 120), pc("regular", null, 1, 100)], 100, 2, "lidl", {});
    expect(r.totalCents).toBe(200);
    expect(r.condition).toBeNull();
  });

  it("picks the exact cheapest mix of several multibuys", () => {
    const d2 = pc("multibuy", null, 2, 300);
    const d3 = pc("multibuy", null, 3, 400);
    const prices = [d2, d3, pc("regular", null, 1, 200)];
    const five = priceLine(prices, 200, 5, "kaufland", {});
    expect(five.totalCents).toBe(700);
    expect(five.condition).toBe(d3); // carries the most units (3 vs 2)
    expect(priceLine(prices, 200, 4, "kaufland", {}).totalCents).toBe(600);
    const six = priceLine(prices, 200, 6, "kaufland", {});
    expect(six.totalCents).toBe(800); // two 3-bundles
    expect(six.condition).toBe(d3);
  });

  it("no unit price: the part not composed of bundles is estimated per item", () => {
    const prices = [pc("multibuy", null, 2, 300)];
    const three = priceLine(prices, null, 3, "kaufland", {});
    expect(three.approximate).toBe(true);
    expect(three.totalCents).toBe(300 + 150);
    const one = priceLine(prices, null, 1, "kaufland", {});
    expect(one.approximate).toBe(true);
    expect(one.totalCents).toBe(150);
  });

  it("card-only offer with the card switched off has no price", () => {
    const r = priceLine([pc("loyalty", "lidl_plus", 1, 85)], null, 2, "lidl", { lidl: false });
    expect(r.totalCents).toBeNull();
    expect(r.cardOnly).toBe(true);
    expect(priceLine([pc("loyalty", "lidl_plus", 1, 85)], null, 2, "lidl", {}).totalCents).toBe(170);
  });
});

describe("reconcile", () => {
  it("ok line: subtotal and total", () => {
    const state = cartOf([offer(IDS.lidlPromo), 2]);
    const s = reconcile(state, catalog, SAMPLE_TODAY);
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].lines[0].status).toBe("ok");
    expect(s.groups[0].subtotalCents).toBe(318);
    expect(s.totalCents).toBe(318);
    expect(s.items).toBe(2);
    expect(s.excluded).toBe(0);
    expect(s.changed).toBe(0);
  });

  it("price_changed carries the previous total and is counted", () => {
    const state = cartOf([offer(IDS.lidlPromo), 2]);
    const changed = structuredClone(offer(IDS.lidlPromo));
    changed.prices = [pc("promo", null, 1, 139), pc("regular", null, 1, 199)];
    const s = reconcile(state, withOffers([changed]), SAMPLE_TODAY);
    const line = s.groups[0].lines[0];
    expect(line.status).toBe("price_changed");
    expect(line.previousTotalCents).toBe(318);
    expect(line.price.totalCents).toBe(278);
    expect(s.totalCents).toBe(278);
    expect(s.changed).toBe(1);
  });

  it("upcoming offers are counted and flagged", () => {
    const state = cartOf([offer(IDS.upcoming), 1]);
    const s = reconcile(state, catalog, SAMPLE_TODAY);
    expect(s.groups[0].lines[0].status).toBe("upcoming");
    expect(s.groups[0].lines[0].counted).toBe(true);
    expect(s.totalCents).toBe(3999);
  });

  it("an upcoming offer with a changed price stays upcoming but is flagged priceChanged", () => {
    const state = cartOf([offer(IDS.upcoming), 1]);
    const changed = structuredClone(offer(IDS.upcoming));
    changed.prices = [pc("promo", null, 1, 3499)];
    changed.regular_cents = null;
    const s = reconcile(state, withOffers([changed]), SAMPLE_TODAY);
    const line = s.groups[0].lines[0];
    expect(line.status).toBe("upcoming");
    expect(line.priceChanged).toBe(true);
    expect(line.previousTotalCents).toBe(3999);
    expect(line.price.totalCents).toBe(3499);
    expect(s.changed).toBe(1);
  });

  it("ended offers are not counted and get a replacement of the same chain and product", () => {
    const ended = offer(IDS.ended);
    const fresh = structuredClone(ended);
    fresh.id = "newer000001";
    fresh.valid_from = "2026-10-16";
    fresh.valid_to = "2026-10-30";
    const otherChain = structuredClone(fresh);
    otherChain.id = "otherchain01";
    otherChain.chain = "lidl";
    const state = cartOf([ended, 2]);
    const s = reconcile(state, withOffers([ended, otherChain, fresh]), SAMPLE_TODAY);
    const line = s.groups[0].lines[0];
    expect(line.status).toBe("ended");
    expect(line.counted).toBe(false);
    expect(line.replacement?.id).toBe("newer000001");
    expect(s.totalCents).toBe(0);
    expect(s.items).toBe(0);
    expect(s.excluded).toBe(1);
  });

  it("an offer that disappeared from the catalog is ended", () => {
    const state = cartOf([offer(IDS.lidlPromo), 1]);
    const s = reconcile(state, withOffers([offer(IDS.billaPromo)]), SAMPLE_TODAY);
    expect(s.groups[0].lines[0].status).toBe("ended");
    expect(s.groups[0].lines[0].replacement).toBeNull();
  });

  it("without a catalog lines are unknown (snapshot prices) and ended only by the snapshot date", () => {
    const state = cartOf([offer(IDS.lidlPromo), 2], [offer(IDS.ended), 1]);
    const s = reconcile(state, null, SAMPLE_TODAY);
    const lidl = s.groups.find((g) => g.chain === "lidl")!;
    const kaufland = s.groups.find((g) => g.chain === "kaufland")!;
    expect(lidl.lines[0].status).toBe("unknown");
    expect(lidl.lines[0].offer).toBeNull();
    expect(lidl.subtotalCents).toBe(318);
    expect(kaufland.lines[0].status).toBe("ended");
    expect(kaufland.lines[0].counted).toBe(false);
    expect(s.totalCents).toBe(318);
  });

  it("groups follow the chain order and aggregate subtotal, items, excluded and changed", () => {
    const changed = structuredClone(offer(IDS.billaPromo));
    changed.prices = [pc("promo", null, 1, 799), pc("regular", null, 1, 1199)];
    const state = setCard(
      cartOf(
        [offer(IDS.billaPromo), 1],
        [offer(IDS.kauflandMultibuy), 1],
        [offer(IDS.lidlPromo), 2],
        [offer(IDS.ended), 1],
        [offer(IDS.cardNoRegular), 1],
      ),
      "lidl",
      false,
    );
    const cat = withOffers([
      changed,
      offer(IDS.kauflandMultibuy),
      offer(IDS.lidlPromo),
      offer(IDS.ended),
      offer(IDS.cardNoRegular),
    ]);
    const s = reconcile(state, cat, SAMPLE_TODAY);
    expect(s.groups.map((g) => g.chain)).toEqual(["lidl", "kaufland", "billa"]);
    const [lidl, kaufland, billa] = s.groups;
    // lidl: 2 x 159 counted; the card-only beer (card switched off) has no price -> excluded
    expect(lidl.subtotalCents).toBe(318);
    expect(lidl.items).toBe(2);
    expect(lidl.excluded).toBe(1);
    // kaufland: one multibuy unit at the regular price 249; the ended apples are excluded
    expect(kaufland.subtotalCents).toBe(249);
    expect(kaufland.excluded).toBe(1);
    expect(billa.subtotalCents).toBe(799);
    expect(s.totalCents).toBe(318 + 249 + 799);
    expect(s.items).toBe(2 + 1 + 1);
    expect(s.excluded).toBe(2);
    expect(s.changed).toBe(1);
  });

  it("the card choice changes the used price", () => {
    const state = cartOf([offer(IDS.lidlPlus), 1]);
    expect(reconcile(state, catalog, SAMPLE_TODAY).totalCents).toBe(99);
    expect(reconcile(setCard(state, "lidl", false), catalog, SAMPLE_TODAY).totalCents).toBe(159);
    expect(reconcile(setCard(setCard(state, "lidl", false), "lidl", true), catalog, SAMPLE_TODAY).totalCents).toBe(99);
  });
});

describe("cart actions", () => {
  it("addOffer merges quantities for the same offer", () => {
    const s = addOffer(addOffer(EMPTY_CART, offer(IDS.lidlPromo), NOW), offer(IDS.lidlPromo), NOW);
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0].qty).toBe(2);
    expect(cartCount(s)).toBe(2);
    expect(inCartQty(s, IDS.lidlPromo)).toBe(2);
    expect(inCartQty(s, "nope")).toBe(0);
  });

  it("quantity is clamped to 1..99 and 0 removes the line", () => {
    const s = cartOf([offer(IDS.lidlPromo), 1]);
    expect(setQty(s, IDS.lidlPromo, 500).lines[0].qty).toBe(MAX_QTY);
    expect(addOffer(s, offer(IDS.lidlPromo), NOW, 200).lines[0].qty).toBe(MAX_QTY);
    expect(setQty(s, IDS.lidlPromo, 0).lines).toHaveLength(0);
    expect(setQty(s, IDS.lidlPromo, 3.7).lines[0].qty).toBe(3);
  });

  it("actions are immutable", () => {
    const s = cartOf([offer(IDS.lidlPromo), 1]);
    const before = JSON.stringify(s);
    setQty(s, IDS.lidlPromo, 5);
    removeLine(s, IDS.lidlPromo);
    setCard(s, "lidl", true);
    clearCart(s);
    expect(JSON.stringify(s)).toBe(before);
  });

  it("clearChain removes only that chain, clearCart keeps the cards", () => {
    const s = setCard(cartOf([offer(IDS.lidlPromo), 1], [offer(IDS.billaPromo), 1]), "lidl", false);
    expect(clearChain(s, "lidl").lines.map((l) => l.chain)).toEqual(["billa"]);
    const cleared = clearCart(s);
    expect(cleared.lines).toHaveLength(0);
    expect(cleared.cards.lidl).toBe(false);
  });

  it("replaceLine swaps the offer and keeps the quantity", () => {
    const ended = offer(IDS.ended);
    const fresh = structuredClone(ended);
    fresh.id = "newer000001";
    const s = replaceLine(cartOf([ended, 4]), IDS.ended, fresh, NOW);
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0].offerId).toBe("newer000001");
    expect(s.lines[0].qty).toBe(4);
    expect(replaceLine(s, "missing", fresh, NOW)).toBe(s);
  });

  it("acceptPrice refreshes the snapshot so the change disappears", () => {
    const state = cartOf([offer(IDS.lidlPromo), 1]);
    const changed = structuredClone(offer(IDS.lidlPromo));
    changed.prices = [pc("promo", null, 1, 139), pc("regular", null, 1, 199)];
    const cat = withOffers([changed]);
    expect(reconcile(state, cat, SAMPLE_TODAY).changed).toBe(1);
    const accepted = acceptPrice(state, changed);
    const s = reconcile(accepted, cat, SAMPLE_TODAY);
    expect(s.changed).toBe(0);
    expect(s.groups[0].lines[0].status).toBe("ok");
  });
});

describe("parseCart", () => {
  it("round-trips a valid cart (an explicit no-card choice is kept)", () => {
    const s = setCard(cartOf([offer(IDS.lidlPromo), 3]), "billa", false);
    expect(parseCart(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("returns an empty cart for a wrong version or garbage", () => {
    expect(parseCart({ version: 2, lines: [], cards: {} })).toEqual(EMPTY_CART);
    expect(parseCart(null)).toEqual(EMPTY_CART);
    expect(parseCart("x")).toEqual(EMPTY_CART);
    expect(parseCart({ version: 1, lines: "no" })).toEqual(EMPTY_CART);
  });

  it("drops malformed lines, clamps quantity and keeps only explicit false cards (the rest equals the default)", () => {
    const good = cartOf([offer(IDS.lidlPromo), 1]).lines[0];
    const raw = {
      version: 1,
      lines: [
        { ...good, qty: 500 },
        { ...good, offerId: 7 },
        { ...good, chain: "aldi" },
        { ...good, qty: 0 },
        { ...good, snapshot: null },
        null,
      ],
      cards: { lidl: true, kaufland: "no", billa: false, aldi: false },
    };
    const s = parseCart(raw);
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0].qty).toBe(MAX_QTY);
    expect(s.cards).toEqual({ billa: false });
  });

  it("drops lines with corrupted prices or dates and keeps the others", () => {
    const good = cartOf([offer(IDS.lidlPromo), 1]).lines[0];
    const other = cartOf([offer(IDS.billaPromo), 1]).lines[0];
    const cond = good.snapshot.prices[0];
    const snap = (patch: object) => ({ ...good, offerId: `bad-${Math.random()}`, snapshot: { ...good.snapshot, ...patch } });
    const raw = {
      version: 1,
      lines: [
        snap({ prices: [null] }),
        snap({ prices: [{ ...cond, kind: "bogus" }] }),
        snap({ prices: [{ ...cond, total_cents: -5 }] }),
        snap({ prices: [{ ...cond, min_qty: 1.5 }] }),
        snap({ valid_from: "17.10.2026" }),
        snap({ valid_to: 20261030 }),
        good,
        other,
      ],
      cards: {},
    };
    const s = parseCart(raw);
    expect(s.lines.map((l) => l.offerId)).toEqual([good.offerId, other.offerId]);
  });

  it("merges duplicate offerIds, summing quantities clamped to 99", () => {
    const good = cartOf([offer(IDS.lidlPromo), 1]).lines[0];
    const s = parseCart({ version: 1, lines: [{ ...good, qty: 2 }, { ...good, qty: 3 }], cards: {} });
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0].qty).toBe(5);
    const big = parseCart({ version: 1, lines: [{ ...good, qty: 80 }, { ...good, qty: 80 }], cards: {} });
    expect(big.lines[0].qty).toBe(MAX_QTY);
  });
});
