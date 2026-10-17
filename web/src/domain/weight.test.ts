import { describe, expect, it } from "vitest";
import { IDS, offerById, sampleCatalog, SAMPLE_TODAY } from "../__fixtures__";
import {
  addOffer,
  cartCount,
  EMPTY_CART,
  gramsOf,
  parseCart,
  priceWeight,
  reconcile,
  setGrams,
  WEIGHT_PRESETS,
  type CartState,
} from "./cart";
import {
  activeCart,
  decodeShare,
  decodeStartParam,
  encodeShare,
  encodeStartParam,
  importKeyOf,
  importShared,
  initialCarts,
  parseCarts,
  shareFromHash,
} from "./carts";
import type { Offer, PriceCondition, PriceKind, Program } from "./types";
import { formatKg, formatWeight } from "./weight";

const NOW = new Date("2026-10-17T08:00:00Z");
const catalog = sampleCatalog();

function pc(kind: PriceKind, program: Program | null, total: number): PriceCondition {
  return { kind, program, min_qty: 1, total_cents: total, per_item_cents: total, discount_pct: null, text: null };
}

/** BILLA fillet: regular 15,33 EUR/kg, 8,39 EUR/kg with the BILLA card. */
const fillet: Offer = {
  ...offerById(catalog, IDS.billaPromo),
  sale_unit: "kg",
  regular_cents: 1533,
  prices: [pc("loyalty", "billa_card", 839), pc("regular", null, 1533)],
};
const withCatalog = { ...catalog, offers: [...catalog.offers.filter((o) => o.id !== fillet.id), fillet] };

describe("weight lines", () => {
  it("add puts 1000 g, qty stays 1; adding again adds 1000 g", () => {
    const s = addOffer(EMPTY_CART, fillet, NOW);
    expect(s.lines[0]).toMatchObject({ qty: 1, grams: 1000 });
    expect(gramsOf(addOffer(s, fillet, NOW).lines[0])).toBe(2000);
  });

  it("steps of 100 g, presets, and going below 100 g removes the line", () => {
    let s = addOffer(EMPTY_CART, fillet, NOW);
    s = setGrams(s, fillet.id, gramsOf(s.lines[0]) + 100);
    expect(s.lines[0].grams).toBe(1100);
    for (const p of WEIGHT_PRESETS) {
      s = setGrams(s, fillet.id, p);
      expect(s.lines[0].grams).toBe(p);
    }
    s = setGrams(s, fillet.id, 100);
    expect(s.lines[0].grams).toBe(100);
    s = setGrams(s, fillet.id, 100 - 100);
    expect(s.lines).toHaveLength(0);
  });

  it("weight lines count as one item", () => {
    const s = setGrams(addOffer(EMPTY_CART, fillet, NOW), fillet.id, 3500);
    expect(cartCount(s)).toBe(1);
    expect(reconcile(s, withCatalog, SAMPLE_TODAY).items).toBe(1);
  });

  it("per kg 1533 x 350 g rounds to 537", () => {
    expect(priceWeight([pc("regular", null, 1533)], 1533, 350, "billa", {}).totalCents).toBe(537);
  });

  it("with card 0,5 kg = 420, without card 767", () => {
    const s = setGrams(addOffer(EMPTY_CART, fillet, NOW), fillet.id, 500);
    const withCard = reconcile(s, withCatalog, SAMPLE_TODAY);
    expect(withCard.groups[0].lines[0].price.totalCents).toBe(420);
    const noCard = reconcile({ ...s, cards: { billa: false } }, withCatalog, SAMPLE_TODAY);
    expect(noCard.groups[0].lines[0].price.totalCents).toBe(767);
  });

  it("a legacy stored kg line with qty 2 becomes 2000 g", () => {
    const legacy = addOffer(EMPTY_CART, fillet, NOW);
    const raw = JSON.parse(JSON.stringify(legacy));
    raw.lines[0].qty = 2;
    delete raw.lines[0].grams;
    const parsed = parseCart(raw);
    expect(parsed.lines[0]).toMatchObject({ qty: 1, grams: 2000 });
  });

  it("grams survive a storage reload", () => {
    const s = setGrams(addOffer(EMPTY_CART, fillet, NOW), fillet.id, 1300);
    expect(parseCart(JSON.parse(JSON.stringify(s))).lines[0].grams).toBe(1300);
    const carts = initialCarts(NOW, s);
    expect(activeCart(parseCarts(JSON.parse(JSON.stringify(carts)))).cart.lines[0].grams).toBe(1300);
  });
});

describe("weight in share links", () => {
  const cart: CartState = setGrams(addOffer(EMPTY_CART, fillet, NOW), fillet.id, 350);

  it("web form keeps grams", () => {
    const v = encodeShare(cart);
    expect(v).toContain("-g350");
    expect(decodeShare(v)).toEqual([{ offerId: fillet.id, qty: 1, grams: 350 }]);
  });

  it("startapp form keeps grams", () => {
    const p = encodeStartParam(cart);
    expect(decodeStartParam(p)).toEqual([{ offerId: fillet.id, qty: 1, grams: 350 }]);
    expect(decodeShare(shareFromHash(`#c=${encodeShare(cart)}`))[0].grams).toBe(350);
  });

  it("importing a shared weight line keeps the grams", () => {
    const items = decodeShare(encodeShare(cart));
    const r = importShared(initialCarts(NOW), items, withCatalog, SAMPLE_TODAY, NOW, true);
    expect(activeCart(r.state).cart.lines[0]).toMatchObject({ offerId: fillet.id, qty: 1, grams: 350 });
  });

  it("an old link with a plain quantity for a weight offer imports whole kilograms", () => {
    const items = decodeShare(`1.${fillet.id}-3`);
    const r = importShared(initialCarts(NOW), items, withCatalog, SAMPLE_TODAY, NOW, true);
    expect(activeCart(r.state).cart.lines[0]).toMatchObject({ offerId: fillet.id, qty: 1, grams: 3000 });
  });

  it("links with different weights of the same offer are different imports", () => {
    const a = decodeShare(`1.${fillet.id}-g250`);
    const b = decodeShare(`1.${fillet.id}-g1000`);
    expect(importKeyOf(a)).not.toBe(importKeyOf(b));
    const first = importShared(initialCarts(NOW), a, withCatalog, SAMPLE_TODAY, NOW, true);
    const second = importShared(first.state, b, withCatalog, SAMPLE_TODAY, NOW, false);
    expect(second.mode).toBe("created");
    expect(activeCart(second.state).cart.lines[0].grams).toBe(1000);
  });

  it("an old link without g still imports pieces", () => {
    const piece = offerById(catalog, IDS.lidlPromo);
    const items = decodeShare(`1.${piece.id}-3`);
    expect(items).toEqual([{ offerId: piece.id, qty: 3 }]);
    const r = importShared(initialCarts(NOW), items, catalog, SAMPLE_TODAY, NOW, true);
    expect(activeCart(r.state).cart.lines[0]).toMatchObject({ offerId: piece.id, qty: 3 });
  });
});

describe("weight formatting", () => {
  it("comma decimals", () => {
    expect(formatKg(250)).toBe("0,25");
    expect(formatKg(1000)).toBe("1");
    expect(formatKg(1300)).toBe("1,3");
    expect(formatWeight(500, "кг")).toBe("0,5 кг");
  });
});
