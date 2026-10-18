import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { Link, MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleCatalog } from "../__fixtures__";
import { CatalogProvider } from "../data/CatalogContext";
import type { CatalogStore } from "../data/catalogStore";
import { ConfigProvider, FALLBACK_CONFIG } from "../data/ConfigContext";
import { LangProvider } from "../i18n/LangContext";
import { noopAnalytics, record, setAnalytics } from "../platform/analytics";
import { resetClarityForTests } from "../platform/clarity";
import { resetConsentCache } from "../platform/consent";
import { reloadPage } from "../platform/document";
import { AID_KEY, flush, getSessionInfo, resetInsightsForTests } from "../platform/insights";
import { prefs } from "../platform/prefs";
import { AnalyticsGate, CatalogLoadedReporter } from "./AnalyticsGate";
import { ConsentBanner } from "./ConsentBanner";
import { ConsentToggle } from "./ConsentToggle";

// jsdom cannot reload; the hard reload is asserted through this mock.
vi.mock("../platform/document", async (orig) => ({
  ...(await orig<typeof import("../platform/document")>()),
  reloadPage: vi.fn(),
}));

interface Call {
  url: string;
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
let calls: Call[] = [];
let analyticsFails = false;

const analyticsCalls = (suffix: string) => calls.filter((c) => c.url.endsWith(suffix));
const clarityQueue = () => ((window as unknown as { clarity?: { q?: unknown[][] } }).clarity?.q ?? []) as unknown[][];
const claritySrc = () => document.querySelectorAll('script[src*="clarity.ms"]');

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      calls.push({ url, body });
      if (url.includes("/analytics/") && analyticsFails) throw new TypeError("network");
      if (url.endsWith("/analytics/session")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ token: "tok", visitor_id: "v_0123456789abcdef0123" }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }),
  );
}

function fakeStore(): CatalogStore {
  const state = { status: "ready", catalog: sampleCatalog(), etag: null, lastCheckedAt: 1, error: null };
  return {
    getSnapshot: () => state,
    subscribe: () => () => undefined,
    init: async () => undefined,
    refresh: async () => undefined,
  } as unknown as CatalogStore;
}

function setup(opts: { strict?: boolean; config?: Record<string, unknown> } = {}) {
  prefs.set("config", {
    ...FALLBACK_CONFIG,
    analytics_enabled: true,
    clarity_id: "abc123xyz",
    ...opts.config,
  });
  const tree = (
    <MemoryRouter initialEntries={["/bg"]}>
      <ConfigProvider>
        <CatalogProvider store={fakeStore()}>
          <LangProvider lang="bg">
            <AnalyticsGate />
            <CatalogLoadedReporter />
            <ConsentBanner />
            <ConsentToggle />
            <Link to="/admin">go-admin</Link>
            <Link to="/bg">go-bg</Link>
          </LangProvider>
        </CatalogProvider>
      </ConfigProvider>
    </MemoryRouter>
  );
  return render(opts.strict ? <StrictMode>{tree}</StrictMode> : tree);
}

async function sentEventNames(): Promise<string[]> {
  await act(async () => {
    await flush();
  });
  return analyticsCalls("/analytics/events").flatMap((c) => c.body.events.map((e: { name: string }) => e.name));
}

beforeEach(() => {
  vi.mocked(reloadPage).mockClear();
  calls = [];
  analyticsFails = false;
  localStorage.clear();
  document.head.innerHTML = "";
  delete (window as unknown as { dataLayer?: unknown }).dataLayer;
  prefs.remove("consent");
  resetConsentCache();
  resetInsightsForTests();
  resetClarityForTests();
  window.history.replaceState(null, "", "/bg");
  installFetch();
});
afterEach(() => {
  cleanup();
  resetInsightsForTests();
  resetClarityForTests();
  setAnalytics(noopAnalytics);
  vi.unstubAllGlobals();
});

describe("analytics consent gating", () => {
  it("before any choice: no analytics request, no Clarity script, nothing stored", async () => {
    setup();
    expect(screen.getAllByRole("button", { name: "Приемам" }).length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.filter((c) => c.url.includes("/analytics/"))).toHaveLength(0);
    expect(claritySrc()).toHaveLength(0);
    expect(localStorage.getItem(AID_KEY)).toBeNull();
    expect(record("cart_add", { offer_id: "a", chain: "lidl", category: "x" })).toBe(false);
  });

  it("the banner is shown for internal analytics alone (no GA4 id)", () => {
    setup({ config: { clarity_id: null } });
    expect(screen.getAllByRole("button", { name: "Приемам" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/GA4, Microsoft Clarity и вътрешна статистика/).length).toBeGreaterThan(0);
  });

  it("no banner when nothing is configured", () => {
    setup({ config: { analytics_enabled: false, clarity_id: null, ga4_id: null } });
    expect(screen.queryByRole("button", { name: "Приемам" })).toBeNull();
  });

  it("refusal: still no analytics requests and no Clarity", async () => {
    setup();
    await userEvent.click(screen.getAllByRole("button", { name: "Отказвам" })[0]);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.filter((c) => c.url.includes("/analytics/"))).toHaveLength(0);
    expect(claritySrc()).toHaveLength(0);
    expect(localStorage.getItem(AID_KEY)).toBeNull();
  });

  it("accept: one session, catalog_loaded once, Clarity loaded with consent mode v2 and the opaque id", async () => {
    setup();
    await userEvent.click(screen.getAllByRole("button", { name: "Приемам" })[0]);
    await waitFor(() => expect(getSessionInfo()).not.toBeNull());
    expect(analyticsCalls("/analytics/session")).toHaveLength(1);
    expect(analyticsCalls("/analytics/session")[0].body.platform).toBe("web");
    expect(await sentEventNames()).toEqual(["catalog_loaded"]);

    expect(claritySrc()).toHaveLength(1);
    expect((claritySrc()[0] as HTMLScriptElement).src).toBe("https://www.clarity.ms/tag/abc123xyz");
    const q = clarityQueue();
    expect(q).toContainEqual(["consentv2", { ad_Storage: "denied", analytics_Storage: "granted" }]);
    expect(q).toContainEqual(["identify", "v_0123456789abcdef0123"]);
    expect(q).toContainEqual(["set", "lang", "bg"]);
    expect(q).toContainEqual(["set", "platform", "web"]);
    expect(q).toContainEqual(["set", "source_kind", "unknown"]);
    expect(q).toContainEqual(["event", "catalog_loaded"]);
    // no personal data in anything handed to Clarity
    expect(JSON.stringify(q)).not.toMatch(/telegram|username|@/i);
  });

  it("StrictMode double mount with a stored consent: one session and one catalog_loaded", async () => {
    prefs.set("consent", { choice: "granted", at: Date.now() });
    resetConsentCache();
    setup({ strict: true });
    await waitFor(() => expect(getSessionInfo()).not.toBeNull());
    expect(analyticsCalls("/analytics/session")).toHaveLength(1);
    expect(claritySrc()).toHaveLength(1);
    const names = await sentEventNames();
    expect(names.filter((n) => n === "catalog_loaded")).toHaveLength(1);
  });

  it("revoke in the toggle: stops tracking, clears the anonymous id and queued events, Clarity consent denied", async () => {
    setup();
    await userEvent.click(screen.getAllByRole("button", { name: "Приемам" })[0]);
    await waitFor(() => expect(getSessionInfo()).not.toBeNull());
    expect(localStorage.getItem(AID_KEY)).not.toBeNull();
    await sentEventNames();
    const sentBefore = analyticsCalls("/analytics/events").length;

    expect(record("cart_add", { offer_id: "a", chain: "lidl", category: "x" })).toBe(true); // queued
    await userEvent.click(screen.getByRole("switch"));

    expect(localStorage.getItem(AID_KEY)).toBeNull();
    expect(record("cart_add", { offer_id: "b", chain: "lidl", category: "x" })).toBe(false);
    await act(async () => {
      await flush();
    });
    expect(analyticsCalls("/analytics/events")).toHaveLength(sentBefore); // the queued event was dropped
    const last = clarityQueue()[clarityQueue().length - 1];
    expect(last).toEqual(["consentv2", { ad_Storage: "denied", analytics_Storage: "denied" }]);
    // the running recorder is stopped for real: consent false, then a hard reload
    expect(clarityQueue()).toContainEqual(["consent", false]);
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it("entering /admin while Clarity runs hard-reloads; Clarity is never loaded on /admin", async () => {
    setup();
    await userEvent.click(screen.getAllByRole("button", { name: "Приемам" })[0]);
    await waitFor(() => expect(getSessionInfo()).not.toBeNull());
    expect(claritySrc()).toHaveLength(1);
    expect(reloadPage).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("go-admin"));
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(clarityQueue()).toContainEqual(["consent", false]);
    // a pending init cannot restart in this page after the stop
    await userEvent.click(screen.getByText("go-bg"));
    expect(claritySrc()).toHaveLength(1);
    expect(clarityQueue().filter((a) => a[0] === "consentv2" && (a[1] as { analytics_Storage: string }).analytics_Storage === "granted")).toHaveLength(1);
  });

  it("opening /admin without a running Clarity does not reload", async () => {
    setup({ config: { clarity_id: null } });
    await userEvent.click(screen.getAllByRole("button", { name: "Приемам" })[0]);
    await waitFor(() => expect(getSessionInfo()).not.toBeNull());
    await userEvent.click(screen.getByText("go-admin"));
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it("visiting /admin and coming back keeps the anonymous id and the session", async () => {
    setup();
    await userEvent.click(screen.getAllByRole("button", { name: "Приемам" })[0]);
    await waitFor(() => expect(getSessionInfo()).not.toBeNull());
    const aid = localStorage.getItem(AID_KEY);
    expect(aid).not.toBeNull();
    await userEvent.click(screen.getByText("go-admin"));
    expect(localStorage.getItem(AID_KEY)).toBe(aid);
    expect(record("cart_add", { offer_id: "a", chain: "lidl", category: "x" })).toBe(false); // not tracked there
    await userEvent.click(screen.getByText("go-bg"));
    expect(localStorage.getItem(AID_KEY)).toBe(aid);
    expect(analyticsCalls("/analytics/session")).toHaveLength(1);
    expect(record("cart_add", { offer_id: "a", chain: "lidl", category: "x" })).toBe(true);
  });

  it("an unreachable analytics endpoint does not break the page", async () => {
    analyticsFails = true;
    setup();
    await userEvent.click(screen.getAllByRole("button", { name: "Приемам" })[0]);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });
});
