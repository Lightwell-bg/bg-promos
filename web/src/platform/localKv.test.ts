import { beforeEach, describe, expect, it } from "vitest";
import { createLocalKv } from "./localKv";

const KEY = "bgpromos:test:v1";

beforeEach(() => {
  window.localStorage.clear();
});

function throwingStorage(): Storage {
  throw new Error("SecurityError");
}

describe("localKv", () => {
  it("writes immediately and reads the latest stored value (another tab's write is seen)", () => {
    const kv = createLocalKv();
    kv.set(KEY, { a: 1 });
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "null")).toEqual({ a: 1 });
    window.localStorage.setItem(KEY, '{"a":2}'); // written by another tab, no event delivered yet
    expect(kv.get(KEY)).toEqual({ a: 2 });
  });

  it("reads values stored earlier and ignores broken JSON", () => {
    window.localStorage.setItem(KEY, '{"x":1}');
    window.localStorage.setItem("bad", "{oops");
    const kv = createLocalKv();
    expect(kv.get(KEY)).toEqual({ x: 1 });
    expect(kv.get("bad")).toBeUndefined();
    expect(kv.get("missing")).toBeUndefined();
  });

  it("remove deletes the stored value", () => {
    window.localStorage.setItem(KEY, "1");
    const kv = createLocalKv();
    kv.remove(KEY);
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(kv.get(KEY)).toBeUndefined();
  });

  it("falls back to memory when localStorage throws", () => {
    const kv = createLocalKv({ getStorage: throwingStorage });
    expect(kv.get(KEY)).toBeUndefined();
    expect(() => kv.set(KEY, { v: 1 })).not.toThrow();
    expect(kv.get(KEY)).toEqual({ v: 1 });
    kv.remove(KEY);
    expect(kv.get(KEY)).toBeUndefined();
  });

  it("falls back to memory when a write fails (quota)", () => {
    const store = {
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    } as unknown as Storage;
    const kv = createLocalKv({ getStorage: () => store });
    expect(() => kv.set(KEY, 5)).not.toThrow();
    expect(kv.get(KEY)).toBe(5);
  });

  it("a failed write keeps the new value authoritative over the stale stored one until a write succeeds", () => {
    const m = new Map<string, string>([[KEY, JSON.stringify("S0")]]);
    let failing = false;
    const store = {
      getItem: (k: string) => m.get(k) ?? null,
      removeItem: (k: string) => void m.delete(k),
      setItem: (k: string, v: string) => {
        if (failing) throw new Error("QuotaExceededError");
        m.set(k, v);
      },
    } as unknown as Storage;
    const kv = createLocalKv({ getStorage: () => store });
    expect(kv.get(KEY)).toBe("S0");
    failing = true;
    expect(kv.set(KEY, "S1")).toBe(false);
    expect(kv.get(KEY)).toBe("S1"); // not the stale S0 still sitting in the storage
    failing = false;
    expect(kv.set(KEY, "S2")).toBe(true);
    expect(kv.get(KEY)).toBe("S2");
    expect(JSON.parse(m.get(KEY) ?? "null")).toBe("S2");
  });

  it("delivers changes made in another tab (storage event) to subscribers", () => {
    const kv = createLocalKv();
    const seen: unknown[] = [];
    const off = kv.subscribe(KEY, (v) => seen.push(v));
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: '{"n":1}' }));
    expect(seen).toEqual([{ n: 1 }]);
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: null }));
    expect(seen).toEqual([{ n: 1 }, undefined]);
    expect(kv.get(KEY)).toBeUndefined();
    window.dispatchEvent(new StorageEvent("storage", { key: "other", newValue: "1" }));
    expect(seen).toHaveLength(2);
    off();
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "3" }));
    expect(seen).toHaveLength(2);
  });

  it("localStorage.clear() in another tab (key null) resets subscribers", () => {
    const kv = createLocalKv();
    const seen: unknown[] = [];
    kv.subscribe(KEY, (v) => seen.push(v));
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(seen).toEqual([undefined]);
  });
});
