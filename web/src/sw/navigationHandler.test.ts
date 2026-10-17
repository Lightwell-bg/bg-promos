import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigationHandler } from "./navigationHandler";

const req = { url: "https://x.test/bg/catalog" } as unknown as Request;
const shell = new Response("shell", { status: 200 });

function stubCaches(hit: Response | undefined) {
  vi.stubGlobal("caches", { match: vi.fn(async () => hit) });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("navigationHandler", () => {
  it("returns the network response when it is fast and healthy", async () => {
    const ok = new Response("page", { status: 200 });
    vi.stubGlobal("fetch", vi.fn(async () => ok));
    stubCaches(shell);
    expect(await navigationHandler({ request: req })).toBe(ok);
  });

  it("keeps 4xx responses from the network", async () => {
    const nf = new Response("nope", { status: 404 });
    vi.stubGlobal("fetch", vi.fn(async () => nf));
    stubCaches(shell);
    expect(await navigationHandler({ request: req })).toBe(nf);
  });

  it("falls back to the precached shell on HTTP 5xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));
    stubCaches(shell);
    expect(await navigationHandler({ request: req })).toBe(shell);
  });

  it("returns the 5xx itself when no shell is precached", async () => {
    const bad = new Response("bad", { status: 503 });
    vi.stubGlobal("fetch", vi.fn(async () => bad));
    stubCaches(undefined);
    expect(await navigationHandler({ request: req })).toBe(bad);
  });

  it("falls back to the shell on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    stubCaches(shell);
    expect(await navigationHandler({ request: req })).toBe(shell);
  });

  it("falls back to the shell after 4 s without a response", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    stubCaches(shell);
    const p = navigationHandler({ request: req });
    await vi.advanceTimersByTimeAsync(3999);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await p).toBe(shell);
  });

  it("rethrows the network error when there is no shell (offline, never installed)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    stubCaches(undefined);
    await expect(navigationHandler({ request: req })).rejects.toThrow("offline");
  });
});
