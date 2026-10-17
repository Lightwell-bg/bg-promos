import { describe, expect, it } from "vitest";
import { IDS, offerById, sampleCatalog } from "../__fixtures__";
import { addOffer, EMPTY_CART, parseCart, priceLine } from "./cart";
import type { Offer, PriceCondition, PriceKind, Program } from "./types";

function pc(kind: PriceKind, program: Program | null, minQty: number, total: number): PriceCondition {
  return {
    kind,
    program,
    min_qty: minQty,
    total_cents: total,
    per_item_cents: total / minQty,
    discount_pct: null,
    text: null,
  };
}

const total = (prices: PriceCondition[], regular: number, qty: number, chain: "lidl" | "kaufland" | "billa", cards = {}) =>
  priceLine(prices, regular, qty, chain, cards).totalCents;

describe("owner regression numbers", () => {
  it("Melitta 1+1 with the Kaufland Card: 1/2/3 items = 32,99 / 32,99 / 65,98", () => {
    const prices = [pc("regular", null, 1, 3299), pc("multibuy", "kaufland_card", 2, 3299)];
    expect([1, 2, 3].map((q) => total(prices, 3299, q, "kaufland"))).toEqual([3299, 3299, 6598]);
  });

  it("Melitta without the card: 3 items = 98,97", () => {
    const prices = [pc("regular", null, 1, 3299), pc("multibuy", "kaufland_card", 2, 3299)];
    expect(total(prices, 3299, 3, "kaufland", { kaufland: false })).toBe(9897);
  });

  it("Corona BILLA, 6 for 5,34 (no program): 1/2/6 items = 1,84 / 3,68 / 5,34", () => {
    const prices = [pc("regular", null, 1, 184), pc("multibuy", null, 6, 534)];
    expect([1, 2, 6].map((q) => total(prices, 184, q, "billa"))).toEqual([184, 368, 534]);
  });
});

/** The Lidl "Баница" listed twice; the server merges both into one price list. */
describe("merged Lidl offer in the cart", () => {
  const merged = [pc("regular", null, 1, 89), pc("loyalty", "lidl_plus", 1, 41), pc("promo", null, 1, 65)];

  it("qty 2: 0,82 with Lidl Plus, 1,30 without the card", () => {
    expect(total(merged, 89, 2, "lidl")).toBe(82);
    expect(total(merged, 89, 2, "lidl", { lidl: false })).toBe(130);
  });
});

describe("sale unit in the cart line", () => {
  const catalog = sampleCatalog();
  const base = offerById(catalog, IDS.billaPromo);

  it("the line stores the offer's sale unit", () => {
    const kg: Offer = { ...base, sale_unit: "kg" };
    expect(addOffer(EMPTY_CART, kg).lines[0].saleUnit).toBe("kg");
    expect(addOffer(EMPTY_CART, { ...base, sale_unit: "l" }).lines[0].saleUnit).toBe("l");
  });

  it("an offer without sale_unit (old cached catalog) is a piece", () => {
    const old = { ...base } as Partial<Offer>;
    delete old.sale_unit;
    expect(addOffer(EMPTY_CART, old as Offer).lines[0].saleUnit).toBe("piece");
  });

  it("parseCart keeps the unit and accepts a stored line without it as a piece", () => {
    const kgState = addOffer(EMPTY_CART, { ...base, sale_unit: "kg" });
    expect(parseCart(JSON.parse(JSON.stringify(kgState))).lines[0].saleUnit).toBe("kg");
    const legacy = JSON.parse(JSON.stringify(kgState));
    delete legacy.lines[0].saleUnit;
    expect(parseCart(legacy).lines[0].saleUnit).toBe("piece");
    legacy.lines[0].saleUnit = "bogus";
    expect(parseCart(legacy).lines[0].saleUnit).toBe("piece");
  });
});
