import { describe, expect, it } from "vitest";
import {
  changedKeys,
  errorName,
  errorProps,
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

  it("reports the error class", () => {
    expect(errorName(new TypeError("secret message"))).toBe("TypeError");
    expect(errorName("string")).toBe("Error");
    expect(errorName({ name: "bad <name>" })).toBe("Error");
  });
});

describe("errorProps", () => {
  const ORIGIN = "https://promos.centerai.eu";

  it("classifies a script error without an error object as external ScriptError", () => {
    const p = errorProps({ where: "window", message: "Script error." }, ORIGIN, "/bg");
    expect(p).toMatchObject({ name: "ScriptError", source: "external", where: "window", path: "/bg" });
  });

  it("keeps ResizeObserver noise recognisable", () => {
    const p = errorProps(
      { where: "window", message: "ResizeObserver loop completed with undelivered notifications." },
      ORIGIN,
      "/",
    );
    expect(p.name).toBe("ResizeObserver");
  });

  it("own vs external vs unknown source; query and hash are dropped from the file", () => {
    const own = errorProps({ where: "window", message: "x", filename: `${ORIGIN}/assets/a.js?v=2#h`, line: 3, col: 4 }, ORIGIN, "/");
    expect(own).toMatchObject({ source: "own", file: "/assets/a.js", line: 3, col: 4 });
    const ext = errorProps({ where: "window", message: "x", filename: "https://cdn.example.com/lib/x.js?k=1", line: 1 }, ORIGIN, "/");
    expect(ext).toMatchObject({ source: "external", file: "cdn.example.com/lib/x.js" });
    expect(ext.col).toBeUndefined();
    expect(errorProps({ where: "window", message: "x" }, ORIGIN, "/")).toMatchObject({ source: "unknown", file: "" });
  });

  it("a string rejection is a Rejection; the source comes from the stack when there is one", () => {
    expect(errorProps({ where: "promise", error: "nope", rejection: true }, ORIGIN, "/")).toMatchObject({
      name: "Rejection",
      message: "nope",
      source: "unknown",
    });
    const err = new Error("boom");
    err.stack = `Error: boom\n    at f (${ORIGIN}/assets/index-abc.js:10:5)`;
    const p = errorProps({ where: "promise", error: err, rejection: true }, ORIGIN, "/");
    expect(p).toMatchObject({ name: "Error", source: "own", file: "/assets/index-abc.js", line: 10, col: 5 });
  });

  it("clips every field to its limit", () => {
    const err = new Error("m".repeat(1000));
    err.stack = "s".repeat(5000);
    const p = errorProps({ where: "w".repeat(200), error: err, componentStack: "\n  at X".repeat(500) }, ORIGIN, "/p".repeat(200));
    expect(String(p.message)).toHaveLength(300);
    expect(String(p.where)).toHaveLength(60);
    expect(String(p.stack).length).toBeLessThanOrEqual(1500);
    expect(String(p.stack)).toContain("Component stack:");
    expect(String(p.path).length).toBeLessThanOrEqual(160);
  });
});
