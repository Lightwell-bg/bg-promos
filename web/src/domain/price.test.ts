import { describe, expect, it } from "vitest";
import { IDS, offerById, sampleCatalog } from "../__fixtures__";
import { conditionChips, formatEUR, formatUnitPrice, priceModel } from "./price";
import type { Offer } from "./types";

const cat = sampleCatalog();
const get = (id: string): Offer => structuredClone(offerById(cat, id));
const keys = (o: Offer) => priceModel(o).chips.map((c) => c.key);

describe("formatEUR", () => {
  it("uses comma decimals and NBSP before the euro sign", () => {
    expect(formatEUR(199)).toBe("1,99 €");
    expect(formatEUR(5)).toBe("0,05 €");
    expect(formatEUR(1000)).toBe("10,00 €");
    expect(formatEUR(398)).toBe("3,98 €");
  });
});

describe("formatUnitPrice", () => {
  it("formats published and computed (≈) unit prices", () => {
    expect(formatUnitPrice({ cents: 499, per: "kg", source: "published" })).toBe("4,99 €/кг");
    expect(formatUnitPrice({ cents: 159, per: "l", source: "published" })).toBe("1,59 €/л");
    expect(formatUnitPrice({ cents: 990, per: "kg", source: "computed" })).toBe("≈ 9,90 €/кг");
  });
});

describe("priceModel", () => {
  it("plain promo: single price, 'for everyone' chip, discount, struck regular", () => {
    const m = priceModel(get(IDS.lidlPromo));
    expect(m.mainCents).toBe(159);
    expect(m.qty).toBe(1);
    expect(m.perItemCents).toBeNull();
    expect(keys(get(IDS.lidlPromo))).toEqual(["cond.all"]);
    expect(m.discountPct).toBe(20);
    expect(m.struckCents).toBe(199);
    expect(m.noCard).toBeNull();
    expect(m.unitText).toBe("1,59 €/л");
    expect(m.unitComputed).toBe(false);
  });

  it("multibuy: total with quantity, per-item line, struck = regular x qty", () => {
    const o = get(IDS.kauflandMultibuy);
    const m = priceModel(o);
    expect(m.mainCents).toBe(398); // total, shown together with qty
    expect(m.qty).toBe(2);
    expect(m.perItemCents).toBe(199);
    expect(m.struckCents).toBe(498); // 249 x 2, same quantity as the total
    expect(m.discountPct).toBe(20);
    expect(keys(o)).toEqual(["cond.multibuy"]);
    expect(m.noCard).toBeNull(); // no program -> no "without card" line
  });

  it("multibuy with a card: both chips and a 'without card' value", () => {
    const o = get(IDS.kauflandOnePlusOne);
    const m = priceModel(o);
    expect(keys(o)).toEqual(["cond.multibuy", "program.kaufland_card"]);
    expect(m.mainCents).toBe(199);
    expect(m.qty).toBe(2);
    expect(m.perItemCents).toBe(100);
    expect(m.struckCents).toBe(398);
    expect(m.noCard).toMatchObject({ state: "value", cents: 199, qty: 1 });
  });

  it("loyalty price: program chip, without-card from no_card, computed unit price", () => {
    const o = get(IDS.lidlPlus);
    const m = priceModel(o);
    expect(keys(o)).toEqual(["program.lidl_plus"]);
    expect(m.noCard).toMatchObject({ state: "value", cents: 159, qty: 1 });
    expect(m.discountPct).toBe(38);
    expect(m.unitText).toBe("≈ 9,90 €/кг");
    expect(m.unitComputed).toBe(true);
    expect(m.savingsPerItemCents).toBe(60);
  });

  it("card-only without no_card and without regular: unknown, no struck price", () => {
    const m = priceModel(get(IDS.cardNoRegular));
    expect(m.noCard).toEqual({ state: "unknown" });
    expect(m.struckCents).toBeNull();
    expect(m.savingsPerItemCents).toBeNull();
  });

  it("without-card value of a multibuy keeps its quantity", () => {
    const o = get(IDS.lidlPlus);
    o.no_card = { kind: "multibuy", program: null, min_qty: 2, total_cents: 300, per_item_cents: 150, discount_pct: null, text: null };
    expect(priceModel(o).noCard).toEqual({ state: "value", cents: 300, qty: 2, perItemCents: 150 });
  });

  it("regular-only: 'regular price' chip, no discount badge, no struck price", () => {
    const o = get(IDS.regularOnly);
    const m = priceModel(o);
    expect(keys(o)).toEqual(["cond.regular"]);
    expect(m.discountPct).toBeNull();
    expect(m.struckCents).toBeNull();
    expect(m.mainCents).toBe(129);
  });

  it("never computes a discount on the client: null stays null", () => {
    const o = get(IDS.lidlPromo);
    o.best!.discount_pct = null;
    expect(priceModel(o).discountPct).toBeNull();
  });

  it("never computes a unit price on the client", () => {
    const o = get(IDS.lidlPromo);
    o.unit_price = null;
    expect(priceModel(o).unitText).toBeNull();
  });

  it("offer without best has no main price", () => {
    const o = get(IDS.lidlPromo);
    o.best = null;
    expect(priceModel(o).mainCents).toBeNull();
  });
});

describe("priceModel with card=without", () => {
  it("shows the no-card condition as the main price, without a no-card line", () => {
    const m = priceModel(get(IDS.lidlPlus), "without");
    expect(m.mainCents).toBe(159);
    expect(m.noCard).toBeNull();
    expect(m.chips.map((c) => c.key)).toEqual(["cond.regular"]);
    expect(priceModel(get(IDS.lidlPlus), "all").mainCents).toBe(99);
  });
});

describe("conditionChips", () => {
  it("covers every program label key", () => {
    const base = get(IDS.lidlPlus).best!;
    for (const p of ["lidl_plus", "kaufland_card", "billa_card", "billa_app"] as const) {
      expect(conditionChips({ ...base, program: p })[0].key).toBe(`program.${p}`);
    }
  });
});
