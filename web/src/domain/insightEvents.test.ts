import { describe, expect, it } from "vitest";
import {
  changedKeys,
  errorName,
  landingSource,
  normalizeQuery,
  parseInitData,
  parseStartParam,
  parseUtm,
  referrerOrigin,
  searchProps,
  startLabel,
} from "./insightEvents";

describe("parseUtm", () => {
  it("keeps only the 4 utm keys, sanitised", () => {
    const utm = parseUtm("?utm_source=Facebook&utm_medium=cpc&utm_campaign=Spring_2026&utm_content=Top Banner!&utm_term=x&fbclid=abc&q=milk");
    expect(utm).toEqual({
      utm_source: "facebook",
      utm_medium: "cpc",
      utm_campaign: "spring_2026",
      utm_content: "topbanner",
    });
  });

  it("drops empty values and truncates to 64 chars", () => {
    expect(parseUtm("?utm_source=%21%21&utm_campaign=" + "a".repeat(100))).toEqual({ utm_campaign: "a".repeat(64) });
  });
});

describe("referrerOrigin", () => {
  it("sends the origin only and ignores the own site", () => {
    expect(referrerOrigin("https://news.example.com/a/b?q=secret#x", "promos.centerai.eu")).toBe("https://news.example.com");
    expect(referrerOrigin("https://promos.centerai.eu/bg", "promos.centerai.eu")).toBeNull();
    expect(referrerOrigin("", "x")).toBeNull();
    expect(referrerOrigin("javascript:alert(1)", "x")).toBeNull();
  });
});

describe("Telegram launch parameters", () => {
  it("decodes tgWebAppData once", () => {
    const raw = "query_id=AAA&user=" + encodeURIComponent('{"id":1}') + "&hash=abc";
    const hash = `#tgWebAppData=${encodeURIComponent(raw)}&tgWebAppVersion=7.0`;
    expect(parseInitData(hash)).toBe(raw);
    expect(parseInitData("#x=1")).toBeNull();
  });

  it("reads the start parameter from query or hash", () => {
    expect(parseStartParam("?tgWebAppStartParam=s_abc", "")).toBe("s_abc");
    expect(parseStartParam("", "#tgWebAppStartParam=s_x-y")).toBe("s_x-y");
    expect(parseStartParam("", "")).toBeNull();
  });

  it("sends only the source label, never a shared cart", () => {
    expect(startLabel("s_spring-banner")).toBe("s_spring-banner");
    expect(startLabel("s_spring__c1_abc.2")).toBe("s_spring");
    expect(startLabel("c1_abc")).toBeNull();
    expect(startLabel("garbage")).toBeNull();
    expect(startLabel(null)).toBeNull();
  });
});

describe("landingSource", () => {
  it("prefers utm, then the label, then the referrer", () => {
    expect(landingSource({ utm_source: "fb", utm_campaign: "spring" }, "s_x", "https://a.b")).toEqual({
      kind: "utm",
      campaign: "spring",
    });
    expect(landingSource({}, "s_promo-top", null)).toEqual({ kind: "startapp", campaign: "promo" });
    expect(landingSource({}, null, "https://a.b")).toEqual({ kind: "referrer", campaign: null });
    expect(landingSource({}, null, null)).toEqual({ kind: "unknown", campaign: null });
  });
});

describe("searchProps", () => {
  it("includes the query only when nothing was found", () => {
    expect(searchProps("  Мляко ", 5)).toEqual({ len: 5, results: 5 });
    expect(searchProps("  Мляко   Прясно ", 0)).toEqual({ len: 14, results: 0, query: "мляко прясно" });
  });

  it("caps the query at 60 chars", () => {
    expect((searchProps("x".repeat(100), 0).query as string).length).toBe(60);
    expect(normalizeQuery("A  B")).toBe("a b");
  });
});

describe("changedKeys / errorName", () => {
  it("lists only the names of changed filters", () => {
    expect(changedKeys({ a: [1], b: "x", c: 0 }, { a: [1], b: "y", c: 5 })).toEqual(["b", "c"]);
    expect(changedKeys({ a: 1 }, { a: 1 })).toEqual([]);
  });

  it("reports the error class only", () => {
    expect(errorName(new TypeError("secret message"))).toBe("TypeError");
    expect(errorName("string")).toBe("Error");
    expect(errorName({ name: "bad <name>" })).toBe("Error");
  });
});
