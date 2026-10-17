import { describe, expect, it } from "vitest";
import { IDS, offerById, sampleCatalog, SAMPLE_TODAY } from "../__fixtures__";
import { DEFAULT_FILTERS, filterOffers, parseFilters, serializeFilters, sortOffers, type Filters } from "./filters";
import type { Offer } from "./types";

const cat = sampleCatalog();
const T = SAMPLE_TODAY;
const f = (patch: Partial<Filters>): Filters => ({ ...DEFAULT_FILTERS, ...patch });
const ids = (list: Offer[]) => list.map((o) => o.id);
const clone = (id: string) => structuredClone(offerById(cat, id));

describe("sort", () => {
  it("price sorts by best.per_item_cents only, never total_cents", () => {
    const multi = clone(IDS.kauflandMultibuy); // total 398, per item 199
    const single = clone(IDS.lidlPromo);
    single.best!.total_cents = 250;
    single.best!.per_item_cents = 250;
    expect(ids(sortOffers([single, multi], "price"))).toEqual([multi.id, single.id]);
  });

  it("price puts offers without best last", () => {
    const none = clone(IDS.lidlPromo);
    none.best = null;
    const cheap = clone(IDS.lidlPlus);
    expect(ids(sortOffers([none, cheap], "price"))).toEqual([cheap.id, none.id]);
  });

  it("savings: desc, nulls last", () => {
    const sorted = sortOffers(cat.offers, "savings");
    expect(sorted[0].id).toBe(IDS.upcoming); // 2000
    expect(sorted[sorted.length - 1].savings_per_item_cents).toBeNull();
  });

  it("discount: desc, null discount last, tie broken by savings", () => {
    const a = clone(IDS.lidlPromo); // 20%, savings 40
    const b = clone(IDS.billaPromo);
    b.best!.discount_pct = 20; // tie, savings 300
    const none = clone(IDS.regularOnly); // null discount
    expect(ids(sortOffers([a, none, b], "discount"))).toEqual([b.id, a.id, none.id]);
  });

  it("ending: valid_to asc, open-ended last", () => {
    const sorted = sortOffers(cat.offers.filter((x) => x.valid_to !== "2026-10-14"), "ending");
    expect(sorted[0].id).toBe(IDS.endingToday);
    expect(sorted[sorted.length - 1].valid_to).toBeNull();
  });

  it("store: chain order then discount", () => {
    const sorted = sortOffers(cat.offers, "store");
    const chains = sorted.map((x) => x.chain);
    expect(chains.indexOf("kaufland")).toBeGreaterThan(chains.lastIndexOf("lidl"));
    expect(chains.indexOf("billa")).toBeGreaterThan(chains.lastIndexOf("kaufland"));
  });

  it("does not mutate the input", () => {
    const copy = [...cat.offers];
    sortOffers(cat.offers, "price");
    expect(cat.offers).toEqual(copy);
  });
});

describe("filterOffers", () => {
  it("default: only active offers (no upcoming, never ended)", () => {
    const out = filterOffers(cat.offers, f({}), T);
    expect(ids(out)).not.toContain(IDS.upcoming);
    expect(ids(out)).not.toContain(IDS.ended);
    expect(ids(out)).toContain(IDS.endingToday);
  });

  it("when: upcoming / all", () => {
    expect(ids(filterOffers(cat.offers, f({ when: "upcoming" }), T))).toEqual([IDS.upcoming]);
    const all = ids(filterOffers(cat.offers, f({ when: "all" }), T));
    expect(all).toContain(IDS.upcoming);
    expect(all).not.toContain(IDS.ended);
  });

  it("card: only / without", () => {
    const only = ids(filterOffers(cat.offers, f({ card: "only" }), T));
    expect(only.sort()).toEqual(
      [IDS.lidlPlus, IDS.kauflandOnePlusOne, IDS.kauflandBrandCard, IDS.billaCard, IDS.cardNoRegular].sort(),
    );
    const without = ids(filterOffers(cat.offers, f({ card: "without" }), T));
    // card offers that also have a price without the card stay in "without card"
    for (const id of only.filter((x) => x !== IDS.cardNoRegular)) expect(without).toContain(id);
    // a card-only price with no known no-card price does not
    expect(without).not.toContain(IDS.cardNoRegular);
    expect(without).toContain(IDS.lidlPromo);
  });

  it("ends within N days", () => {
    expect(ids(filterOffers(cat.offers, f({ ends: 1 }), T)).sort()).toEqual([IDS.endingToday, IDS.lidlPlus].sort());
    // open-ended offers never match "ends within"
    expect(ids(filterOffers(cat.offers, f({ ends: 7 }), T))).not.toContain(IDS.regularOnly);
  });

  it("price range applies to per-item price", () => {
    // multibuy total 398 would fail pmax=250, per item 199 passes
    const out = ids(filterOffers(cat.offers, f({ pmax: 250 }), T));
    expect(out).toContain(IDS.kauflandMultibuy);
    expect(out).not.toContain(IDS.billaPromo);
    const range = ids(filterOffers(cat.offers, f({ pmin: 150, pmax: 200 }), T));
    expect(range).toEqual(expect.arrayContaining([IDS.lidlPromo, IDS.kauflandMultibuy, IDS.endingToday]));
    expect(range).not.toContain(IDS.lidlPlus);
  });

  it("min discount, chains, categories", () => {
    const d = filterOffers(cat.offers, f({ disc: 30 }), T);
    expect(d.every((o) => (o.best?.discount_pct ?? 0) >= 30)).toBe(true);
    expect(filterOffers(cat.offers, f({ chains: ["billa"] }), T).every((o) => o.chain === "billa")).toBe(true);
    expect(filterOffers(cat.offers, f({ cats: ["dairy"] }), T).every((o) => o.category === "dairy")).toBe(true);
  });

  it("matchIds restricts to text-search results", () => {
    const out = filterOffers(cat.offers, f({}), T, new Set([IDS.lidlPromo, IDS.ended]));
    expect(ids(out)).toEqual([IDS.lidlPromo]);
  });
});

describe("URL query", () => {
  it("round-trips non-default values and omits defaults", () => {
    const filters = f({
      chains: ["lidl", "billa"],
      cats: ["dairy"],
      q: "мляко",
      sort: "price",
      pmin: 150,
      pmax: 500,
      disc: 25,
      card: "only",
      when: "all",
      ends: 3,
    });
    const params = serializeFilters(filters);
    expect(parseFilters(new URLSearchParams(params.toString()))).toEqual(filters);
    expect(serializeFilters(DEFAULT_FILTERS).toString()).toBe("");
  });

  it("ignores junk values", () => {
    const p = parseFilters(new URLSearchParams("chain=x,lidl&sort=zzz&disc=7&card=maybe&when=never&ends=9&pmin=abc"));
    expect(p.chains).toEqual(["lidl"]);
    expect(p).toMatchObject({ sort: "discount", disc: 0, card: "all", when: "now", ends: 0, pmin: null });
  });
});
