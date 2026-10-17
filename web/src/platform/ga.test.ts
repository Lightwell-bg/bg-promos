import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGoogleAnalytics, deleteGaCookies, mapEvent } from "./ga";
import { CONSENT_TTL_MS, readConsent, saveConsent } from "./consent";
import { prefs } from "./prefs";

const ID = "G-TEST123";
const gtagScripts = () => document.querySelectorAll('script[src*="googletagmanager.com"]');
const layer = () => (window as unknown as { dataLayer?: unknown[] }).dataLayer ?? [];
const asArray = (e: unknown) => Array.from(e as ArrayLike<unknown>);
const SAFE_PAGE = { page_location: `${location.origin}/`, page_title: "BG Promos", page_referrer: "" };

beforeEach(() => {
  document.head.innerHTML = "";
  delete (window as unknown as { dataLayer?: unknown }).dataLayer;
  delete (window as unknown as { gtag?: unknown }).gtag;
});
afterEach(() => {
  document.cookie = "_ga=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
});

describe("google analytics + consent", () => {
  it("injects nothing before consent", () => {
    const ga = createGoogleAnalytics(ID);
    ga.track("search", { len: 3, results: 5 });
    ga.pageView("/bg");
    expect(gtagScripts()).toHaveLength(0);
    expect(layer()).toHaveLength(0);
  });

  it("loads gtag.js with the id and Consent Mode v2 defaults after consent", () => {
    const ga = createGoogleAnalytics(ID);
    ga.enable();
    const scripts = gtagScripts();
    expect(scripts).toHaveLength(1);
    expect((scripts[0] as HTMLScriptElement).src).toContain(`id=${ID}`);
    const calls = layer().map(asArray);
    expect(calls[0]).toEqual([
      "consent",
      "default",
      { analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" },
    ]);
    expect(calls).toContainEqual(["consent", "update", { analytics_storage: "granted" }]);
    const config = calls.find((c) => c[0] === "config");
    expect(config?.[1]).toBe(ID);
    expect(config?.[2]).toMatchObject({
      send_page_view: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });
    ga.enable(); // idempotent
    expect(gtagScripts()).toHaveLength(1);
  });

  it("maps events, never forwards search text or unknown events", () => {
    const ga = createGoogleAnalytics(ID);
    ga.enable();
    const before = layer().length;
    ga.track("search", { len: 4, results: 12, q: "milka", query: "milka" });
    ga.track("unknown_event", { a: 1 });
    ga.track("view_offer", { chain: "lidl", category: "dairy_eggs", name: "Milka шоколад" });
    const added = layer().slice(before).map(asArray).filter((c) => c[0] === "event");
    expect(added).toEqual([
      ["event", "search", { query_length: 4, results_count: 12, ...SAFE_PAGE }],
      ["event", "view_offer", { chain: "lidl", category: "dairy_eggs", ...SAFE_PAGE }],
    ]);
    expect(JSON.stringify(added)).not.toContain("milka");
  });

  it("never sends the query string, hash, product title or referrer with any hit", () => {
    window.history.replaceState({}, "", "/bg/offer/abc?q=milka&utm=1#frag");
    document.title = "Milka шоколад | BG Promos";
    const ga = createGoogleAnalytics(ID);
    ga.enable();
    ga.track("view_offer", { chain: "lidl", category: "sweets", name: "Milka шоколад" });
    ga.track("search", { len: 5, results: 2, q: "milka" });
    ga.pageView("/bg/search?q=milka#x", "bg");
    const all = layer().map(asArray);
    const hits = all.filter((c) => c[0] === "event" || c[0] === "set");
    expect(hits.length).toBeGreaterThanOrEqual(4);
    const json = JSON.stringify(hits);
    expect(json).not.toMatch(/milka/i);
    expect(json).not.toContain("?");
    expect(json).not.toContain("#");
    for (const h of hits) {
      const p = h[h.length - 1] as Record<string, unknown>;
      expect(p.page_title).toBe("BG Promos");
      expect(p.page_referrer).toBe("");
      expect(String(p.page_location)).toMatch(new RegExp(`^${location.origin}/bg/[a-z/]+$`));
    }
    expect(all.find((c) => c[0] === "set")?.[1]).toEqual({
      page_location: `${location.origin}/bg/offer/abc`,
      page_title: "BG Promos",
      page_referrer: "",
    });
    const pv = all.find((c) => c[1] === "page_view");
    expect((pv?.[2] as Record<string, unknown>).page_location).toBe(`${location.origin}/bg/search`);
    window.history.replaceState({}, "", "/");
    document.title = "";
  });

  it("page_view carries the path only", () => {
    const ga = createGoogleAnalytics(ID);
    ga.enable();
    ga.pageView("/bg/search", "bg");
    const last = asArray(layer()[layer().length - 1]);
    expect(last[1]).toBe("page_view");
    expect(JSON.stringify(last)).not.toContain("?");
  });

  it("revoking stops further events, denies storage and deletes _ga cookies", () => {
    const ga = createGoogleAnalytics(ID);
    ga.enable();
    document.cookie = "_ga=GA1.1.1.1; path=/";
    expect(document.cookie).toContain("_ga=");
    ga.disable();
    expect(document.cookie).not.toContain("_ga=");
    const after = layer().length;
    ga.track("brochure_click", { chain: "lidl" });
    ga.pageView("/bg");
    expect(layer()).toHaveLength(after);
    expect(asArray(layer()[after - 1])).toEqual(["consent", "update", { analytics_storage: "denied" }]);
    expect((window as unknown as Record<string, unknown>)[`ga-disable-${ID}`]).toBe(true);
    ga.enable(); // consent given again: re-enabled without a second script
    expect(gtagScripts()).toHaveLength(1);
    ga.track("brochure_click", { chain: "lidl" });
    expect(layer().length).toBeGreaterThan(after);
  });

  it("mapEvent whitelists safe strings", () => {
    expect(mapEvent("sort_change", { sort: "discount" })?.params).toEqual({ sort: "discount" });
    expect(mapEvent("sort_change", { sort: "has space & <b>" })?.params).toEqual({});
    expect(mapEvent("toString")).toBeNull();
  });

  it("deleteGaCookies removes _ga_* too", () => {
    document.cookie = "_ga_ABC=1; path=/";
    deleteGaCookies(document, "localhost");
    expect(document.cookie).not.toContain("_ga_ABC");
  });
});

describe("consent storage", () => {
  it("stores the choice with a timestamp and re-asks after 12 months", () => {
    prefs.remove("consent");
    expect(readConsent()).toBeNull();
    const t0 = Date.UTC(2026, 0, 1);
    saveConsent("granted", t0);
    expect(readConsent(t0 + 1000)).toEqual({ choice: "granted", at: t0 });
    expect(readConsent(t0 + CONSENT_TTL_MS - 1)).not.toBeNull();
    expect(readConsent(t0 + CONSENT_TTL_MS + 1)).toBeNull();
    prefs.set("consent", { choice: "maybe", at: t0 });
    expect(readConsent(t0)).toBeNull();
    prefs.remove("consent");
  });
});
