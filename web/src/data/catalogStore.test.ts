import { describe, expect, it, vi } from "vitest";
import { sampleCatalog } from "../__fixtures__";
import { createMemoryStorage } from "../platform/storage";
import { CATALOG_KEY, CatalogStore, REFRESH_THROTTLE_MS } from "./catalogStore";

function json(body: unknown, etag = '"v1"', status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ETag: etag, "Content-Type": "application/json" } });
}

async function seeded(etag: string | null = '"v1"') {
  const storage = createMemoryStorage();
  await storage.set(CATALOG_KEY, { catalog: sampleCatalog(), etag, checkedAt: 1000 });
  return storage;
}

describe("CatalogStore", () => {
  it("first run without cache: loads, ready, persists with ETag", async () => {
    const storage = createMemoryStorage();
    const fetchFn = vi.fn().mockResolvedValue(json(sampleCatalog()));
    const store = new CatalogStore({ storage, fetchFn, now: () => 5000 });
    expect(store.getSnapshot().status).toBe("loading");
    await store.init();
    const s = store.getSnapshot();
    expect(s.status).toBe("ready");
    expect(s.catalog?.offers.length).toBeGreaterThan(5);
    expect(s.etag).toBe('"v1"');
    expect(s.lastCheckedAt).toBe(5000);
    expect(await storage.get(CATALOG_KEY)).toMatchObject({ etag: '"v1"', checkedAt: 5000 });
  });

  it("cache-first: renders the cached catalog before the network answers", async () => {
    const storage = await seeded();
    let release!: (r: Response) => void;
    const fetchFn = vi.fn().mockReturnValue(new Promise<Response>((r) => (release = r)));
    const store = new CatalogStore({ storage, fetchFn });
    const p = store.init();
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe("ready"));
    expect(store.getSnapshot().catalog).not.toBeNull();
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled());
    expect(fetchFn.mock.calls[0][1].headers["If-None-Match"]).toBe('"v1"');
    release(new Response(null, { status: 304 }));
    await p;
  });

  it("304 keeps the cache and updates lastCheckedAt", async () => {
    const storage = await seeded();
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 304 }));
    const store = new CatalogStore({ storage, fetchFn, now: () => 9000 });
    await store.init();
    const s = store.getSnapshot();
    expect(s.status).toBe("ready");
    expect(s.catalog?.generated_at).toBe("2026-10-17T16:05:00+03:00");
    expect(s.lastCheckedAt).toBe(9000);
    expect(s.etag).toBe('"v1"');
  });

  it("200 with a new ETag replaces the cache", async () => {
    const storage = await seeded();
    const next = sampleCatalog();
    next.generated_at = "2026-10-18T09:00:00+03:00";
    const fetchFn = vi.fn().mockResolvedValue(json(next, '"v2"'));
    const store = new CatalogStore({ storage, fetchFn });
    await store.init();
    expect(store.getSnapshot().etag).toBe('"v2"');
    expect(store.getSnapshot().catalog?.generated_at).toBe(next.generated_at);
  });

  it("network failure with a cache: offline, data kept", async () => {
    const storage = await seeded();
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const store = new CatalogStore({ storage, fetchFn });
    await store.init();
    expect(store.getSnapshot().status).toBe("offline");
    expect(store.getSnapshot().catalog).not.toBeNull();
    expect(store.getSnapshot().lastCheckedAt).toBe(1000);
  });

  it("network failure without a cache: error", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const store = new CatalogStore({ storage: createMemoryStorage(), fetchFn });
    await store.init();
    expect(store.getSnapshot().status).toBe("error");
    expect(store.getSnapshot().catalog).toBeNull();
  });

  it("HTTP 500 with a cache keeps showing data and reports the error", async () => {
    const storage = await seeded();
    const fetchFn = vi.fn().mockResolvedValue(new Response("oops", { status: 500 }));
    const store = new CatalogStore({ storage, fetchFn });
    await store.init();
    expect(store.getSnapshot()).toMatchObject({ status: "ready", error: "HTTP 500" });
  });

  it("throttles refreshes to once per 60 s unless forced", async () => {
    let t = 0;
    const fetchFn = vi.fn().mockImplementation(async () => new Response(null, { status: 304 }));
    const store = new CatalogStore({ storage: await seeded(), fetchFn, now: () => t });
    await store.init(); // attempt at t=0
    expect(fetchFn).toHaveBeenCalledTimes(1);
    t = REFRESH_THROTTLE_MS - 1;
    await store.refresh();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    t = REFRESH_THROTTLE_MS + 1;
    await store.refresh();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await store.refresh({ force: true });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("deduplicates concurrent refreshes", async () => {
    const fetchFn = vi.fn().mockImplementation(async () => json(sampleCatalog()));
    const store = new CatalogStore({ storage: createMemoryStorage(), fetchFn });
    await Promise.all([store.refresh({ force: true }), store.refresh({ force: true })]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("ignores a malformed payload", async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ nope: true }));
    const store = new CatalogStore({ storage: createMemoryStorage(), fetchFn });
    await store.init();
    expect(store.getSnapshot().status).toBe("error");
  });

  it("invalid JSON body is a status error (HTTP 502), not offline", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("<html>oops", { status: 200 }));
    const store = new CatalogStore({ storage: createMemoryStorage(), fetchFn });
    await store.init();
    expect(store.getSnapshot()).toMatchObject({ status: "error", error: "HTTP 502" });
  });

  it("invalid JSON with a cache keeps the data as ready with an error note", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));
    const store = new CatalogStore({ storage: await seeded(), fetchFn });
    await store.init();
    expect(store.getSnapshot()).toMatchObject({ status: "ready", error: "HTTP 502" });
  });

  it("passes an abort signal (network timeout) to fetch; a timeout is a network error", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const store = new CatalogStore({ storage: await seeded(), fetchFn });
    await store.init();
    expect(fetchFn.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(store.getSnapshot().status).toBe("offline");
  });

  it("a stuck cache read does not block the network (timeout)", async () => {
    const storage = createMemoryStorage();
    storage.get = () => new Promise(() => undefined); // never resolves
    const fetchFn = vi.fn().mockResolvedValue(json(sampleCatalog()));
    const store = new CatalogStore({ storage, fetchFn, cacheTimeoutMs: 20 });
    await store.init();
    expect(store.getSnapshot().status).toBe("ready");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a late cache read never overwrites a fresher network result", async () => {
    const stale = sampleCatalog();
    stale.generated_at = "2026-10-01T00:00:00+03:00";
    const fresh = sampleCatalog();
    fresh.generated_at = "2026-10-18T09:00:00+03:00";
    let releaseCache!: (v: unknown) => void;
    const storage = createMemoryStorage();
    storage.get = (() => new Promise((r) => (releaseCache = r as (v: unknown) => void))) as typeof storage.get;
    const fetchFn = vi.fn().mockResolvedValue(json(fresh, '"v2"'));
    const store = new CatalogStore({ storage, fetchFn, cacheTimeoutMs: 20 });
    await store.init(); // cache timed out, network applied
    expect(store.getSnapshot().catalog?.generated_at).toBe(fresh.generated_at);
    releaseCache({ catalog: stale, etag: '"v1"', checkedAt: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getSnapshot().catalog?.generated_at).toBe(fresh.generated_at);
    expect(store.getSnapshot().etag).toBe('"v2"');
  });

  it("a fresh fetch that resolves while the cache read is pending wins", async () => {
    const stale = sampleCatalog();
    stale.generated_at = "2026-10-01T00:00:00+03:00";
    const fresh = sampleCatalog();
    fresh.generated_at = "2026-10-18T09:00:00+03:00";
    let releaseCache!: (v: unknown) => void;
    const storage = createMemoryStorage();
    storage.get = (() => new Promise((r) => (releaseCache = r as (v: unknown) => void))) as typeof storage.get;
    const fetchFn = vi.fn().mockResolvedValue(json(fresh, '"v2"'));
    const store = new CatalogStore({ storage, fetchFn, cacheTimeoutMs: 1000 });
    const p = store.init();
    await store.refresh({ force: true }); // e.g. a visibility refresh during startup
    expect(store.getSnapshot().catalog?.generated_at).toBe(fresh.generated_at);
    releaseCache({ catalog: stale, etag: '"v1"', checkedAt: 1 });
    await p;
    expect(store.getSnapshot().catalog?.generated_at).toBe(fresh.generated_at);
  });
});
