import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AID_KEY,
  TEST_KEY,
  captureLaunch,
  record,
  resetInsightsForTests,
  revokeInsights,
  startInsights,
  suspendInsights,
} from "./insights";
import { localKv } from "./localKv";
import sessionFixture from "../__fixtures__/admin/session.json";

interface Call {
  url: string;
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function resp(status: number, data: unknown = {}): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as unknown as Response;
}

/** Fetch double: the session call succeeds; the events call fails `eventFailures` times (Infinity = always). */
function installFetch(opts: { eventFailures?: number; sessionFails?: boolean; expireToken?: boolean } = {}) {
  const calls: Call[] = [];
  let failuresLeft = opts.eventFailures ?? 0;
  let sessionCalls = 0;
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    calls.push({ url, body });
    if (url.endsWith("/analytics/session")) {
      if (opts.sessionFails) throw new TypeError("network");
      sessionCalls++;
      // Response shape = shared contract fixture (checked against the real backend in pytest).
      return resp(200, { ...sessionFixture, token: sessionCalls === 1 ? "tok" : "tok2" });
    }
    if (opts.expireToken && body.token === "tok") return resp(401, { detail: "invalid token" });
    if (failuresLeft > 0) {
      failuresLeft--;
      throw new TypeError("network");
    }
    return resp(200, { accepted: body.events?.length ?? 0 });
  });
  vi.stubGlobal("fetch", fn);
  return {
    calls,
    sessions: () => calls.filter((c) => c.url.endsWith("/analytics/session")),
    events: () => calls.filter((c) => c.url.endsWith("/analytics/events")),
  };
}

function setLocation(url: string) {
  window.history.replaceState(null, "", url);
}

function setReferrer(value: string) {
  Object.defineProperty(document, "referrer", { value, configurable: true });
}

async function tick(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetInsightsForTests();
  setLocation("/bg");
  setReferrer("");
});
afterEach(() => {
  resetInsightsForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setLocation("/");
});

describe("insights: nothing before start", () => {
  it("does not queue or send anything while not started", async () => {
    const f = installFetch();
    expect(record("cart_add", { offer_id: "a", chain: "lidl", category: "x" })).toBe(false);
    await tick(20_000);
    expect(f.calls).toHaveLength(0);
    expect(localStorage.getItem(AID_KEY)).toBeNull();
  });
});

describe("insights: session", () => {
  it("opens one session per app load even when started twice (StrictMode)", async () => {
    const f = installFetch();
    setLocation("/bg?utm_source=Facebook&utm_campaign=Spring&utm_term=ignored&q=milk");
    setReferrer("https://news.example.com/article?x=secret");
    startInsights("bg");
    startInsights("bg");
    await tick();
    expect(f.sessions()).toHaveLength(1);
    const body = f.sessions()[0].body;
    expect(body.platform).toBe("web");
    expect(body.lang).toBe("bg");
    expect(body.utm).toEqual({ utm_source: "facebook", utm_campaign: "spring" });
    expect(body.referrer).toBe("https://news.example.com");
    expect(typeof body.session_id).toBe("string");
    expect(body.anon_id).toBe(JSON.parse(localStorage.getItem(AID_KEY) as string));
    expect(body).not.toHaveProperty("init_data");
    expect(body).not.toHaveProperty("test");
  });

  it("web share link: the utm in the query is sent as-is", async () => {
    const f = installFetch();
    setLocation("/bg/cart/import?utm_source=share&utm_medium=cart&utm_campaign=share&utm_content=web#c=1.abc");
    startInsights("bg");
    await tick();
    expect(f.sessions()[0].body.utm).toEqual({
      utm_source: "share", utm_medium: "cart", utm_campaign: "share", utm_content: "web",
    });
  });

  it("old unlabeled cart/import link is tagged as a legacy share; other pages and real utm are untouched", async () => {
    let f = installFetch();
    setLocation("/bg/cart/import#c=1.abc");
    startInsights("bg");
    await tick();
    expect(f.sessions()[0].body.utm).toEqual({ utm_source: "share", utm_campaign: "share", utm_content: "legacy" });

    resetInsightsForTests();
    f = installFetch();
    setLocation("/bg/cart/import?utm_source=fb#c=1.abc");
    startInsights("bg");
    await tick();
    expect(f.sessions()[0].body.utm).toEqual({ utm_source: "fb" });

    resetInsightsForTests();
    f = installFetch();
    setLocation("/bg/cart");
    startInsights("bg");
    await tick();
    expect(f.sessions()[0].body.utm).toEqual({});
  });

  it("creates the anonymous id only after start and reuses it", async () => {
    installFetch();
    expect(localStorage.getItem(AID_KEY)).toBeNull();
    localKv.set(AID_KEY, "11111111-2222-4333-8444-555555555555");
    startInsights("ru");
    await tick();
    expect(JSON.parse(localStorage.getItem(AID_KEY) as string)).toBe("11111111-2222-4333-8444-555555555555");
  });

  it("platform is miniapp with Telegram initData; no Telegram ids and no anon id are sent", async () => {
    const f = installFetch();
    const raw = "query_id=AAH&user=" + encodeURIComponent('{"id":777,"first_name":"Ann","username":"ann"}') + "&hash=abc";
    setLocation(`/bg#tgWebAppData=${encodeURIComponent(raw)}&tgWebAppStartParam=s_promo-top__c1_secretcart&tgWebAppVersion=7`);
    startInsights("bg");
    await tick();
    const body = f.sessions()[0].body;
    expect(body.platform).toBe("miniapp");
    expect(body.init_data).toBe(raw);
    expect(body.start_param).toBe("s_promo-top");
    expect(body).not.toHaveProperty("anon_id");
    expect(body).not.toHaveProperty("referrer");
    const keys = Object.keys(body).sort();
    expect(keys).toEqual(["init_data", "lang", "platform", "session_id", "start_param", "utm"]);
    expect(JSON.stringify(body)).not.toContain("secretcart");
    expect(localStorage.getItem(AID_KEY)).toBeNull();
  });

  it("?bgtest=1 is remembered and sent as test:true", async () => {
    const f = installFetch();
    setLocation("/bg?bgtest=1");
    captureLaunch();
    expect(localStorage.getItem(TEST_KEY)).toBe("true");
    resetInsightsForTests(); // a later page load without the parameter
    setLocation("/bg");
    startInsights("bg");
    await tick();
    expect(f.sessions()[0].body.test).toBe(true);
  });
});

describe("insights: event queue", () => {
  it("batches events and flushes every 5 s with the session token", async () => {
    const f = installFetch();
    startInsights("bg");
    await tick();
    record("cart_add", { offer_id: "a1", chain: "lidl", category: "dairy" });
    record("card_toggle", { chain: "lidl", on: true });
    expect(f.events()).toHaveLength(0);
    await tick(5_000);
    expect(f.events()).toHaveLength(1);
    const sent = f.events()[0].body;
    expect(sent.token).toBe("tok");
    expect(sent.session_id).toBe(f.sessions()[0].body.session_id);
    expect(sent.events).toHaveLength(2);
    const ids = new Set(sent.events.map((e: { event_id: string }) => e.event_id));
    expect(ids.size).toBe(2);
    expect(sent.events[0]).toMatchObject({ name: "cart_add", props: { offer_id: "a1", chain: "lidl", category: "dairy" } });
    expect(typeof sent.events[0].ts).toBe("string");
    await tick(30_000);
    expect(f.events()).toHaveLength(1); // nothing is re-sent
  });

  it("events recorded before the session answer wait and are sent afterwards", async () => {
    const f = installFetch();
    startInsights("bg");
    record("search", { len: 3, results: 2 });
    await tick(5_000);
    expect(f.events()).toHaveLength(1);
  });

  it("never sends more than 50 events in one request", async () => {
    const f = installFetch();
    startInsights("bg");
    await tick();
    for (let i = 0; i < 120; i++) record("cart_qty", { offer_id: "a", chain: "lidl", delta: 1, unit: "piece" });
    await tick(20_000);
    const sizes = f.events().map((c) => c.body.events.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(50);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(120);
  });

  it("caps a request by size (server limit 32 KB) when events are large", async () => {
    const f = installFetch();
    startInsights("bg");
    await tick();
    const big = { name: "Error", where: "window", message: "m".repeat(300), stack: "é".repeat(1500), path: "/bg" };
    for (let i = 0; i < 18; i++) record("app_error", { ...big, line: i });
    await tick(20_000);
    const calls = f.events();
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(new TextEncoder().encode(JSON.stringify(c.body)).length).toBeLessThan(32 * 1024);
    expect(calls.reduce((a, c) => a + c.body.events.length, 0)).toBe(18);
  });

  it("retries a failed batch with the SAME event_id (max 3 sends), then drops it silently", async () => {
    const f = installFetch({ eventFailures: Infinity });
    startInsights("bg");
    await tick();
    record("cart_add", { offer_id: "a1", chain: "lidl", category: "dairy" });
    await tick(60_000);
    const calls = f.events();
    expect(calls).toHaveLength(3);
    const ids = calls.map((c) => c.body.events[0].event_id);
    expect(new Set(ids).size).toBe(1);
    await tick(120_000);
    expect(f.events()).toHaveLength(3);
  });

  it("401 -> /session again with the SAME session_id, then the same event_ids are re-sent with the new token", async () => {
    const f = installFetch({ expireToken: true });
    startInsights("bg");
    await tick();
    record("cart_add", { offer_id: "a1", chain: "lidl", category: "dairy" });
    await tick(30_000);
    expect(f.sessions()).toHaveLength(2);
    expect(f.sessions()[1].body.session_id).toBe(f.sessions()[0].body.session_id);
    expect(f.sessions()[1].body.anon_id).toBe(f.sessions()[0].body.anon_id);
    const calls = f.events();
    expect(calls).toHaveLength(2);
    expect(calls[0].body.token).toBe("tok");
    expect(calls[1].body.token).toBe("tok2");
    expect(calls[1].body.events[0].event_id).toBe(calls[0].body.events[0].event_id);
    await tick(60_000);
    expect(f.events()).toHaveLength(2);
  });

  it("400 and 413 are final: the batch is not re-sent", async () => {
    for (const status of [400, 413]) {
      resetInsightsForTests();
      const f = installFetch();
      (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/analytics/session")) return resp(200, { ...sessionFixture });
        f.calls.push({ url, body: JSON.parse(init?.body as string) });
        return resp(status, { detail: "x" });
      });
      startInsights("bg");
      await tick();
      record("cart_add", { offer_id: "a1", chain: "lidl", category: "dairy" });
      await tick(60_000);
      expect(f.events()).toHaveLength(1);
    }
  });

  it("a stored anonymous id that is not a UUID is replaced (the backend would answer 400)", async () => {
    const f = installFetch();
    localKv.set(AID_KEY, "not-a-uuid-but-long-enough-xx");
    startInsights("bg");
    await tick();
    expect(f.sessions()[0].body.anon_id).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  });

  it("a retry that succeeds is not repeated", async () => {
    const f = installFetch({ eventFailures: 1 });
    startInsights("bg");
    await tick();
    record("cart_add", { offer_id: "a1", chain: "lidl", category: "dairy" });
    await tick(60_000);
    const calls = f.events();
    expect(calls).toHaveLength(2);
    expect(calls[1].body.events[0].event_id).toBe(calls[0].body.events[0].event_id);
  });

  it("flushes through sendBeacon when the page is hidden", async () => {
    const f = installFetch();
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
    startInsights("bg");
    await tick();
    record("share_copy", { block: "web", ok: true });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(beacon).toHaveBeenCalledTimes(1);
    await tick(30_000);
    expect(f.events()).toHaveLength(0); // already handed to the beacon
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    delete (navigator as unknown as { sendBeacon?: unknown }).sendBeacon;
  });

  it("once and dedupe options queue a logical event a single time", async () => {
    const f = installFetch();
    startInsights("bg");
    await tick();
    expect(record("catalog_loaded", { offers: 10, from_cache: false }, { once: true })).toBe(true);
    expect(record("catalog_loaded", { offers: 10, from_cache: false }, { once: true })).toBe(false);
    expect(record("offer_view", { offer_id: "a", chain: "x", category: "y" }, { dedupeMs: 1000 })).toBe(true);
    expect(record("offer_view", { offer_id: "a", chain: "x", category: "y" }, { dedupeMs: 1000 })).toBe(false);
    await tick(5_000);
    expect(f.events()[0].body.events).toHaveLength(2);
  });

  it("rejects unknown event names", async () => {
    installFetch();
    startInsights("bg");
    await tick();
    expect(record("hack" as never, {})).toBe(false);
  });
});

describe("insights: stop (consent revoked) and failures", () => {
  it("clears the anonymous id and the queue and sends nothing more", async () => {
    const f = installFetch();
    startInsights("bg");
    await tick();
    expect(localStorage.getItem(AID_KEY)).not.toBeNull();
    record("cart_add", { offer_id: "a1", chain: "lidl", category: "dairy" });
    revokeInsights();
    expect(localStorage.getItem(AID_KEY)).toBeNull();
    expect(record("cart_add", { offer_id: "a2", chain: "lidl", category: "dairy" })).toBe(false);
    await tick(60_000);
    expect(f.events()).toHaveLength(0);
  });

  it("a granted-again session after revoke starts fresh", async () => {
    const f = installFetch();
    startInsights("bg");
    await tick();
    revokeInsights();
    startInsights("bg");
    await tick();
    expect(f.sessions()).toHaveLength(2);
    expect(f.sessions()[1].body.session_id).not.toBe(f.sessions()[0].body.session_id);
  });

  it("suspend (/admin) keeps the anonymous id and the session; resume continues them", async () => {
    const f = installFetch();
    startInsights("bg");
    await tick();
    const aid = localStorage.getItem(AID_KEY);
    expect(aid).not.toBeNull();
    record("cart_add", { offer_id: "a1", chain: "lidl", category: "dairy" });
    suspendInsights();
    expect(localStorage.getItem(AID_KEY)).toBe(aid);
    expect(record("cart_add", { offer_id: "a2", chain: "lidl", category: "dairy" })).toBe(false);
    startInsights("bg"); // back from /admin
    await tick();
    expect(localStorage.getItem(AID_KEY)).toBe(aid);
    expect(f.sessions()).toHaveLength(1); // no second session
    expect(record("cart_add", { offer_id: "a3", chain: "lidl", category: "dairy" })).toBe(true);
    await tick(10_000);
    const sent = f.events().flatMap((c) => c.body.events.map((e: { props: { offer_id: string } }) => e.props.offer_id));
    expect(sent).toEqual(["a1", "a3"]); // a1 handed over on suspend, a2 never recorded
    expect(new Set(f.events().map((c) => c.body.session_id))).toEqual(new Set([f.sessions()[0].body.session_id]));
  });

  it("an unreachable analytics endpoint never throws and never repeats forever", async () => {
    const f = installFetch({ sessionFails: true });
    expect(() => startInsights("bg")).not.toThrow();
    await tick(60_000);
    expect(f.sessions()).toHaveLength(3);
    expect(record("cart_add", { offer_id: "a", chain: "lidl", category: "x" })).toBe(false);
    await tick(60_000);
    expect(f.events()).toHaveLength(0);
  });
});
