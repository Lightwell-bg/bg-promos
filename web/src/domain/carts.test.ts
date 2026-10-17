import { describe, expect, it } from "vitest";
import { IDS, offerById, sampleCatalog, SAMPLE_TODAY } from "../__fixtures__";
import { addOffer, EMPTY_CART, type CartState } from "./cart";
import {
  activeCart,
  CARTS_VERSION,
  decodeShare,
  decodeStartParam,
  deleteCart,
  encodeShare,
  encodeStartParam,
  START_PARAM_MAX,
  telegramStartLink,
  importKeyOf,
  importShared,
  initialCarts,
  MAX_CARTS,
  MAX_SHARED_LINES,
  parseCarts,
  renameCart,
  shareFromHash,
  shareUrl,
  switchCart,
  updateActive,
  type CartsState,
} from "./carts";

const catalog = sampleCatalog();
const NOW = new Date("2026-10-17T08:00:00Z");
const A = IDS.lidlPromo;
const B = IDS.billaPromo;
const C0 = IDS.kauflandMultibuy;

function cartOf(...entries: Array<[string, number]>): CartState {
  return entries.reduce((s, [id, q]) => addOffer(s, offerById(catalog, id), NOW, q), EMPTY_CART);
}
const ids = (c: CartState) => c.lines.map((l) => l.offerId).sort();

describe("share codec", () => {
  it("roundtrips ids and quantities", () => {
    const value = encodeShare(cartOf([A, 2], [B, 3]));
    expect(value).toMatch(/^1\./);
    expect(decodeShare(value)).toEqual(
      expect.arrayContaining([
        { offerId: A, qty: 2 },
        { offerId: B, qty: 3 },
      ]),
    );
    expect(decodeShare(value)).toHaveLength(2);
  });

  it("an empty list has no share value", () => {
    expect(encodeShare(EMPTY_CART)).toBeNull();
  });

  it("ignores garbage and invalid parts", () => {
    expect(decodeShare(null)).toEqual([]);
    expect(decodeShare("")).toEqual([]);
    expect(decodeShare("2.abc")).toEqual([]);
    expect(decodeShare("1.")).toEqual([]);
    expect(decodeShare("1." + "x".repeat(5000))).toEqual([]);
    expect(decodeShare(`1.zzzz-1_${A}-0_${A.toUpperCase()}-1_nothex000000-1_${B}-2`)).toEqual([{ offerId: B, qty: 2 }]);
    expect(decodeShare(`1.${A}-abc_${A}_${A}-100`)).toEqual([]);
  });

  it("merges duplicates and clamps the quantity to 99", () => {
    expect(decodeShare(`1.${A}-2_${A}-3`)).toEqual([{ offerId: A, qty: 5 }]);
    expect(decodeShare(`1.${A}-99_${A}-50`)).toEqual([{ offerId: A, qty: 99 }]);
    const big = encodeShare({ ...EMPTY_CART, lines: [{ ...cartOf([A, 1]).lines[0], qty: 500 }] });
    expect(decodeShare(big)).toEqual([{ offerId: A, qty: 99 }]);
  });

  it("caps the number of items", () => {
    const parts = Array.from({ length: MAX_SHARED_LINES + 10 }, (_, i) => `${i.toString(16).padStart(12, "0")}-1`);
    expect(decodeShare("1." + parts.join("_"))).toHaveLength(MAX_SHARED_LINES);
  });

  it("shareFromHash reads the c parameter", () => {
    expect(shareFromHash(`#c=1.${A}-2`)).toBe(`1.${A}-2`);
    expect(shareFromHash(`c=1.${A}-2`)).toBe(`1.${A}-2`);
    expect(shareFromHash(`#x=1&c=1.${A}-2`)).toBe(`1.${A}-2`);
    expect(shareFromHash("#other=1")).toBeNull();
    expect(shareFromHash("")).toBeNull();
  });

  it("shareUrl builds an absolute fragment link", () => {
    expect(shareUrl("https://x.test/", "bg", "1.a")).toBe("https://x.test/bg/cart/import#c=1.a");
  });

  it("importKeyOf ignores the order", () => {
    expect(importKeyOf([{ offerId: A, qty: 1 }, { offerId: B, qty: 2 }])).toBe(
      importKeyOf([{ offerId: B, qty: 2 }, { offerId: A, qty: 1 }]),
    );
    expect(importKeyOf([{ offerId: A, qty: 1 }])).not.toBe(importKeyOf([{ offerId: A, qty: 2 }]));
  });
});

describe("Telegram start parameter", () => {
  const lines = (n: number, qty = 1): CartState => {
    const first = cartOf([A, 1]).lines[0];
    return { ...EMPTY_CART, lines: Array.from({ length: n }, (_, i) => ({ ...first, qty, offerId: i.toString(16).padStart(12, "0") })) };
  };

  it("roundtrips ids and quantities; quantity 1 is omitted", () => {
    const p = encodeStartParam(cartOf([A, 2], [B, 1]));
    expect(p).toMatch(/^c1_[0-9a-f]{12}-2_[0-9a-f]{12}$/);
    expect(p).toContain(`${B}`);
    expect(p).not.toContain(`${B}-1`);
    expect(decodeStartParam(p).sort((x, y) => x.offerId.localeCompare(y.offerId))).toEqual(
      [
        { offerId: A, qty: 2 },
        { offerId: B, qty: 1 },
      ].sort((x, y) => x.offerId.localeCompare(y.offerId)),
    );
  });

  it("rejects wrong prefix and invalid characters", () => {
    expect(decodeStartParam(`c2_${A}`)).toEqual([]);
    expect(decodeStartParam(`${A}`)).toEqual([]);
    expect(decodeStartParam(`c1_${A}.2`)).toEqual([]);
    expect(decodeStartParam(`c1_${A}!`)).toEqual([]);
    expect(decodeStartParam("")).toEqual([]);
    expect(decodeStartParam(null)).toEqual([]);
    expect(decodeStartParam("c1_" + "a".repeat(600))).toEqual([]);
  });

  it("skips bad parts and merges duplicates", () => {
    expect(decodeStartParam(`c1_${A}-2_zzz_${A}-3_${B}-0`)).toEqual([{ offerId: A, qty: 5 }]);
  });

  it("empty list gives null", () => {
    expect(encodeStartParam(EMPTY_CART)).toBeNull();
  });

  it("the 512-char limit: 39 plain lines fit, 40 do not", () => {
    expect(START_PARAM_MAX).toBe(512);
    const ok = encodeStartParam(lines(39));
    expect(ok).not.toBeNull();
    expect(ok?.length).toBeLessThanOrEqual(512);
    expect(encodeStartParam(lines(40))).toBeNull();
    // with quantities each line is longer
    expect(encodeStartParam(lines(34, 2))).not.toBeNull();
    expect(encodeStartParam(lines(35, 2))).toBeNull();
  });

  it("builds the t.me link", () => {
    expect(telegramStartLink("promoseubot", "c1_x")).toBe("https://t.me/promoseubot?startapp=c1_x");
    expect(telegramStartLink("@promoseubot", "c1_x")).toBe("https://t.me/promoseubot?startapp=c1_x");
  });
});

describe("importShared", () => {
  const items = [
    { offerId: A, qty: 2 },
    { offerId: B, qty: 1 },
  ];

  it("first launch with a single empty list: fills it", () => {
    const s = initialCarts(NOW);
    const r = importShared(s, items, catalog, SAMPLE_TODAY, NOW, true);
    expect(r.mode).toBe("filled");
    expect(r.added).toBe(2);
    expect(r.missing).toBe(0);
    expect(r.state.carts).toHaveLength(1);
    expect(ids(activeCart(r.state).cart)).toEqual([A, B].sort());
  });

  it("not a first launch: even an empty own list is kept and a separate shared list is created", () => {
    const s = initialCarts(NOW);
    const r = importShared(s, items, catalog, SAMPLE_TODAY, new Date(NOW.getTime() + 1000), false);
    expect(r.mode).toBe("created");
    expect(r.state.carts).toHaveLength(2);
    expect(r.state.carts[0].origin).toBe("own");
    expect(r.state.carts[0].cart.lines).toHaveLength(0);
    expect(activeCart(r.state).origin).toBe("shared");
  });

  it("first launch flag with an existing non-empty list still creates a separate list", () => {
    const s = initialCarts(NOW, cartOf([C0, 1]));
    const r = importShared(s, items, catalog, SAMPLE_TODAY, new Date(NOW.getTime() + 1000), true);
    expect(r.mode).toBe("created");
    expect(r.state.carts).toHaveLength(2);
  });

  it("creates a shared list and activates it when the active list is not empty", () => {
    const own = cartOf([IDS.kauflandMultibuy, 1]);
    const s = initialCarts(NOW, own);
    const r = importShared(s, items, catalog, SAMPLE_TODAY, new Date(NOW.getTime() + 1000));
    expect(r.mode).toBe("created");
    expect(r.state.carts).toHaveLength(2);
    expect(r.state.activeId).toBe(r.cartId);
    const created = activeCart(r.state);
    expect(created.origin).toBe("shared");
    expect(ids(created.cart)).toEqual([A, B].sort());
    const kept = r.state.carts.find((c) => c.id === s.activeId);
    expect(kept?.cart).toBe(own);
    expect(kept?.origin).toBe("own");
  });

  it("opening the same link again (other order) switches to the existing list", () => {
    const s = initialCarts(NOW, cartOf([IDS.kauflandMultibuy, 1]));
    const first = importShared(s, items, catalog, SAMPLE_TODAY, NOW);
    const back = switchCart(first.state, s.activeId);
    const again = importShared(back, [...items].reverse(), catalog, SAMPLE_TODAY, NOW);
    expect(again.mode).toBe("existing");
    expect(again.cartId).toBe(first.cartId);
    expect(again.state.carts).toHaveLength(2);
    expect(again.state.activeId).toBe(first.cartId);
  });

  it("counts ended and unknown offers as missing", () => {
    const r = importShared(
      initialCarts(NOW),
      [...items, { offerId: IDS.ended, qty: 1 }, { offerId: "ffffffffffff", qty: 1 }],
      catalog,
      SAMPLE_TODAY,
      NOW,
      true,
    );
    expect(r.mode).toBe("filled");
    expect(r.added).toBe(2);
    expect(r.missing).toBe(2);
  });

  it("nothing when every item is missing; state untouched", () => {
    const s = initialCarts(NOW, cartOf([A, 1]));
    const r = importShared(s, [{ offerId: IDS.ended, qty: 1 }, { offerId: "ffffffffffff", qty: 1 }], catalog, SAMPLE_TODAY, NOW);
    expect(r.mode).toBe("nothing");
    expect(r.missing).toBe(2);
    expect(r.state).toBe(s);
    expect(importShared(s, [], catalog, SAMPLE_TODAY, NOW).mode).toBe("nothing");
  });

  it("eviction at MAX_CARTS keeps the active and own lists", () => {
    let s = initialCarts(NOW, cartOf([A, 1]));
    const ownId = s.activeId;
    for (let i = 0; i < MAX_CARTS + 3; i++) {
      s = switchCart(s, ownId);
      const r = importShared(s, [{ offerId: B, qty: i + 1 }], catalog, SAMPLE_TODAY, new Date(NOW.getTime() + (i + 1) * 1000));
      s = r.state;
      expect(s.carts.length).toBeLessThanOrEqual(MAX_CARTS);
      expect(s.carts.some((c) => c.id === ownId)).toBe(true);
      expect(s.carts.some((c) => c.id === r.cartId)).toBe(true);
      expect(s.activeId).toBe(r.cartId);
    }
    expect(s.carts).toHaveLength(MAX_CARTS);
  });
});

describe("list operations", () => {
  it("updateActive only touches the active list", () => {
    const s = importShared(initialCarts(NOW, cartOf([A, 1])), [{ offerId: B, qty: 1 }], catalog, SAMPLE_TODAY, NOW).state;
    const next = updateActive(s, () => EMPTY_CART);
    expect(activeCart(next).cart.lines).toHaveLength(0);
    expect(next.carts.find((c) => c.id !== s.activeId)?.cart.lines).toHaveLength(1);
    expect(updateActive(s, (c) => c)).toBe(s);
  });

  it("rename trims, collapses spaces, caps at 40 and clears to the default", () => {
    const s = initialCarts(NOW);
    expect(activeCart(renameCart(s, s.activeId, "  Дача   пикник ")).name).toBe("Дача пикник");
    expect(activeCart(renameCart(s, s.activeId, "x".repeat(60))).name).toHaveLength(40);
    expect(activeCart(renameCart(renameCart(s, s.activeId, "a"), s.activeId, "  ")).name).toBeNull();
  });

  it("delete: moves the active list, and the last list is replaced by an empty one", () => {
    const s = importShared(initialCarts(NOW, cartOf([A, 1])), [{ offerId: B, qty: 1 }], catalog, SAMPLE_TODAY, NOW).state;
    const afterOne = deleteCart(s, s.activeId, NOW);
    expect(afterOne.carts).toHaveLength(1);
    expect(afterOne.activeId).toBe(afterOne.carts[0].id);
    const afterAll = deleteCart(afterOne, afterOne.activeId, NOW);
    expect(afterAll.carts).toHaveLength(1);
    expect(activeCart(afterAll).cart.lines).toHaveLength(0);
  });
});

describe("parseCarts", () => {
  it("roundtrips a stored state through JSON", () => {
    const s = importShared(initialCarts(NOW, cartOf([A, 2])), [{ offerId: B, qty: 1 }], catalog, SAMPLE_TODAY, NOW).state;
    const back = parseCarts(JSON.parse(JSON.stringify(s)));
    expect(back.version).toBe(CARTS_VERSION);
    expect(back.activeId).toBe(s.activeId);
    expect(back.carts.map((c) => [c.id, c.origin, c.importKey, ids(c.cart)])).toEqual(
      s.carts.map((c) => [c.id, c.origin, c.importKey, ids(c.cart)]),
    );
  });

  it("drops corrupted entries and duplicate ids", () => {
    const good = initialCarts(NOW);
    const raw = {
      version: 2,
      activeId: good.activeId,
      carts: [
        null,
        "x",
        { id: "", origin: "own", createdAt: "x" },
        { id: "bad1", origin: "weird", createdAt: "x" },
        { id: "bad2", origin: "own" },
        good.carts[0],
        { ...good.carts[0], name: "dup" },
      ],
    };
    const r = parseCarts(raw);
    expect(r.carts).toHaveLength(1);
    expect(r.carts[0].name).toBeNull();
  });

  it("an invalid activeId falls back to the first list", () => {
    const s = initialCarts(NOW);
    expect(parseCarts({ ...s, activeId: "nope" }).activeId).toBe(s.carts[0].id);
  });

  it("migrates the v1 single cart", () => {
    const v1 = cartOf([A, 3]);
    const r = parseCarts(undefined, JSON.parse(JSON.stringify(v1)), NOW);
    expect(r.carts).toHaveLength(1);
    expect(r.carts[0].origin).toBe("own");
    expect(activeCart(r).cart.lines.map((l) => [l.offerId, l.qty])).toEqual([[A, 3]]);
  });

  it("garbage gives an empty initial state", () => {
    for (const g of [undefined, null, 5, "x", [], {}, { version: 2 }, { version: 2, carts: [] }, { version: 1, carts: [1] }]) {
      const r: CartsState = parseCarts(g, undefined, NOW);
      expect(r.carts).toHaveLength(1);
      expect(activeCart(r).cart.lines).toHaveLength(0);
    }
  });
});
