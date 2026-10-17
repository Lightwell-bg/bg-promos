import { describe, expect, it } from "vitest";
import { IDS, sampleCatalog } from "../__fixtures__";
import { buildSearchIndex, expandQuery, normalize, searchOffers, suggest, translitToCyr, translitToLat } from "./search";

const cat = sampleCatalog();
const index = buildSearchIndex(cat);
const found = (q: string) => searchOffers(index, q).map((o) => o.id);

describe("normalize", () => {
  it("lowercases, ё->е, strips punctuation and collapses spaces", () => {
    expect(normalize("  Сёмга,  Coca-Cola!! 0,5л ")).toBe("семга coca cola 0 5л");
  });
});

describe("transliteration", () => {
  it("latin -> cyrillic (Bulgarian scheme)", () => {
    expect(translitToCyr("milka")).toBe("милка");
    expect(translitToCyr("shtastie")).toBe("щастие");
    expect(translitToCyr("zhelyazo")).toBe("желязо");
    expect(translitToCyr("chay")).toBe("чай");
    expect(translitToCyr("yuli")).toBe("юли");
  });
  it("cyrillic -> latin", () => {
    expect(translitToLat("милка")).toBe("milka");
    expect(translitToLat("щастие")).toBe("shtastie");
  });
});

describe("expandQuery", () => {
  it("expands RU words to BG synonyms and keeps the original", () => {
    const [g] = expandQuery("молоко");
    expect(g.map((v) => v.join(" "))).toEqual(expect.arrayContaining(["молоко", "мляко"]));
  });
  it("supports multi-word keys", () => {
    const groups = expandQuery("стиральный порошок");
    expect(groups).toHaveLength(1);
    expect(groups[0].map((v) => v.join(" "))).toContain("прах за пране");
  });
  it.each([
    ["сыра", "сирене"],
    ["мяса", "месо"],
    ["яиц", "яйца"],
    ["яйца", "яйца"],
    ["молока", "мляко"],
    ["хлеба", "хляб"],
  ])("maps inflected Russian word %s to %s", (word, bg) => {
    const [g] = expandQuery(word);
    expect(g.map((v) => v.join(" "))).toContain(bg);
  });
  it("does not mangle short words", () => {
    const [g] = expandQuery("крем");
    expect(g.map((v) => v.join(" "))).toContain("крем");
  });
  it("one group per token (tokens are ANDed)", () => {
    expect(expandQuery("молоко pilos")).toHaveLength(2);
  });
});

describe("searchOffers", () => {
  it("RU 'молоко' finds BG 'Прясно мляко'", () => {
    expect(found("молоко")).toContain(IDS.lidlPromo);
  });
  it("latin 'milka' finds 'Milka Шоколад'", () => {
    expect(found("milka")).toContain(IDS.lidlPlus);
  });
  it("cyrillic 'милка' finds latin 'Milka'", () => {
    expect(found("милка")).toContain(IDS.lidlPlus);
  });
  it("prefix 'кашк' finds 'Кашкавал'", () => {
    expect(found("кашк")).toContain(IDS.billaCard);
  });
  it("RU 'курица' finds 'Пилешко филе'", () => {
    expect(found("курица")).toContain(IDS.billaPromo);
  });
  it("RU 'сыр' finds 'Кашкавал'", () => {
    expect(found("сыр")).toContain(IDS.billaCard);
  });
  it("tokens are ANDed", () => {
    expect(found("мляко верея")).toEqual([IDS.kauflandOnePlusOne]);
    expect(found("мляко pilos")).toEqual([IDS.lidlPromo]);
    expect(found("мляко несъществуващо")).toEqual([]);
  });
  it("matches by category label in either language", () => {
    expect(found("млечни")).toContain(IDS.lidlPromo);
    expect(found("молочные")).toContain(IDS.lidlPromo);
  });
  it("matches by brand", () => {
    expect(found("nivea")).toContain(IDS.kauflandBrandCard);
  });
  it("empty query returns nothing", () => {
    expect(found("   ")).toEqual([]);
  });
  it("index is memoised per catalog", () => {
    expect(buildSearchIndex(cat)).toBe(index);
  });
});

describe("suggest", () => {
  it("offers terms, categories and brands for a prefix", () => {
    const s = suggest(index, "мл");
    expect(s.terms.length).toBeGreaterThan(0);
    expect(s.categories.map((c) => c.id)).toContain("dairy");
    const brand = suggest(index, "mil");
    expect(brand.brands).toContain("Milka");
  });
});
