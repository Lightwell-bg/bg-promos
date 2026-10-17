import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import categories from "./categories.json";
import { pageMeta } from "./meta";
import pages from "./pages.json";

describe("categories.json", () => {
  it("matches the backend taxonomy exactly (ids, labels, icons, order)", () => {
    const py = readFileSync(path.resolve(__dirname, "../../../src/bg_promos/web/categories.py"), "utf-8");
    const block = py.slice(py.indexOf("CATEGORIES:"), py.indexOf("CATEGORY_IDS"));
    const rows = [...block.matchAll(/\("([a-z_]+)", "([^"]+)", "([^"]+)", "([^"]+)"\)/g)].map((m) => ({
      id: m[1],
      bg: m[2],
      ru: m[3],
      icon: m[4],
    }));
    expect(rows.length).toBeGreaterThan(10);
    expect(categories).toEqual(rows);
  });
});

describe("pageMeta", () => {
  it("returns static meta per route and language", () => {
    expect(pageMeta("bg", "/bg")?.title).toBe(pages.bg.home.title);
    expect(pageMeta("ru", "/ru/catalog")?.title).toBe(pages.ru.catalog.title);
    expect(pageMeta("ru", "/ru/legal/terms")?.title).toBe(pages.ru.legal.terms.title);
  });
  it("fills the category name", () => {
    expect(pageMeta("bg", "/bg/c/produce")?.title).toContain("Плодове и зеленчуци");
    expect(pageMeta("ru", "/ru/c/dairy_eggs")?.description).toContain("Молочное, сыры и яйца");
  });
  it("is null for offer pages and unknown legal pages", () => {
    expect(pageMeta("bg", "/bg/offer/abc")).toBeNull();
    expect(pageMeta("bg", "/bg/legal/nope")).toBeNull();
  });
  it("keeps titles and descriptions within search-friendly limits", () => {
    for (const lang of ["bg", "ru"] as const) {
      const all = [pages[lang].home, pages[lang].catalog, pages[lang].search, pages[lang].brochures, ...Object.values(pages[lang].legal)];
      for (const m of all) {
        expect(m.title.length).toBeLessThanOrEqual(70);
        expect(m.description.length).toBeLessThanOrEqual(170);
      }
    }
  });
});
