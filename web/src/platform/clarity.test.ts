import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clarityConsent,
  clarityEvent,
  clarityIdentify,
  clarityLoaded,
  clarityTag,
  loadClarity,
  resetClarityForTests,
  stopClarity,
} from "./clarity";

const queue = () => ((window as unknown as { clarity?: { q?: unknown[][] } }).clarity?.q ?? []) as unknown[][];
const scripts = () => document.querySelectorAll('script[src*="clarity.ms"]');

beforeEach(() => {
  document.head.innerHTML = "";
  resetClarityForTests();
});
afterEach(() => resetClarityForTests());

describe("clarity", () => {
  it("does nothing until loaded: no script, consent/tags/events are no-ops", () => {
    clarityConsent(true);
    clarityTag("lang", "bg");
    clarityEvent("cart_add");
    expect(scripts()).toHaveLength(0);
    expect(queue()).toHaveLength(0);
    expect(clarityLoaded()).toBe(false);
  });

  it("rejects a malformed project id", () => {
    expect(loadClarity('x"><script>')).toBe(false);
    expect(scripts()).toHaveLength(0);
  });

  it("loads the tag once (no re-init on repeated calls)", () => {
    expect(loadClarity("abc123xyz")).toBe(true);
    expect(loadClarity("abc123xyz")).toBe(true);
    expect(scripts()).toHaveLength(1);
    expect((scripts()[0] as HTMLScriptElement).src).toBe("https://www.clarity.ms/tag/abc123xyz");
  });

  it("passes consent mode v2: analytics granted, ads denied; revoke denies and stops tags/events", () => {
    loadClarity("abc123xyz");
    clarityConsent(true);
    expect(queue()[0]).toEqual(["consentv2", { ad_Storage: "denied", analytics_Storage: "granted" }]);
    clarityTag("lang", "bg");
    clarityTag("platform", "web");
    clarityTag("campaign", null);
    clarityEvent("catalog_loaded");
    const before = queue().length;
    clarityConsent(false);
    expect(queue()[before]).toEqual(["consentv2", { ad_Storage: "denied", analytics_Storage: "denied" }]);
    const after = queue().length;
    clarityEvent("cart_add");
    clarityTag("lang", "ru");
    clarityIdentify("v_0123456789abcdef0123");
    expect(queue()).toHaveLength(after);
  });

  it("sends tags as set-calls and events by name only", () => {
    loadClarity("abc123xyz");
    clarityConsent(true);
    clarityTag("source_kind", "utm");
    clarityEvent("share_link_created");
    expect(queue()).toContainEqual(["set", "source_kind", "utm"]);
    expect(queue()).toContainEqual(["event", "share_link_created"]);
  });

  it("identifies with the opaque visitor id only", () => {
    loadClarity("abc123xyz");
    clarityConsent(true);
    clarityIdentify("123456789"); // a Telegram-like id
    clarityIdentify("ann_the_user");
    clarityIdentify("v_0123456789abcdef0123");
    const idents = queue().filter((c) => c[0] === "identify");
    expect(idents).toEqual([["identify", "v_0123456789abcdef0123"]]);
  });

  it("stopClarity: consent false + consentv2 denied, and the tag cannot be loaded again in this page", () => {
    expect(stopClarity()).toBe(false); // nothing running: no-op, a later load is still allowed
    expect(loadClarity("abc123xyz")).toBe(true);
    clarityConsent(true);
    expect(stopClarity()).toBe(true);
    expect(queue().slice(-2)).toEqual([
      ["consent", false],
      ["consentv2", { ad_Storage: "denied", analytics_Storage: "denied" }],
    ]);
    const len = queue().length;
    clarityEvent("cart_add");
    expect(queue()).toHaveLength(len);
    document.head.innerHTML = "";
    resetClarityForTests();
    expect(loadClarity("abc123xyz")).toBe(true);
  });

  it("after stopClarity a pending init cannot start the recorder", () => {
    loadClarity("abc123xyz");
    stopClarity();
    expect(loadClarity("abc123xyz")).toBe(false); // refused: no restart before the reload
    expect(scripts()).toHaveLength(1);
  });
});
