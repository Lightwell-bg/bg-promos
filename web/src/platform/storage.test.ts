import { describe, expect, it } from "vitest";
import { createIdbStorage, IDB_RETRY_COOLDOWN_MS, type IdbOps } from "./storage";

function fakeIdb() {
  const data = new Map<string, unknown>();
  const state = { fail: false, calls: 0 };
  const guard = () => {
    state.calls++;
    if (state.fail) throw new Error("idb down");
  };
  const ops: IdbOps = {
    async get<T>(k: string) {
      guard();
      return data.get(k) as T | undefined;
    },
    async set(k, v) {
      guard();
      data.set(k, v);
    },
    async del(k) {
      guard();
      data.delete(k);
    },
  };
  return { ops, data, state };
}

describe("createIdbStorage", () => {
  it("mirrors successful reads into memory and keeps serving them after an IDB error", async () => {
    const { ops, data, state } = fakeIdb();
    data.set("a", 1);
    const s = createIdbStorage(ops, () => 0);
    expect(await s.get("a")).toBe(1);
    state.fail = true;
    expect(await s.get("a")).toBe(1);
  });

  it("mirrors writes: a value written while IDB works survives a later failure", async () => {
    const { ops, state } = fakeIdb();
    const s = createIdbStorage(ops, () => 0);
    await s.set("k", "v");
    state.fail = true;
    expect(await s.get("k")).toBe("v");
  });

  it("writes while IDB is failing are kept in memory", async () => {
    const { ops, state } = fakeIdb();
    state.fail = true;
    const s = createIdbStorage(ops, () => 0);
    await s.set("k", 5);
    expect(await s.get("k")).toBe(5);
    await s.del("k");
    expect(await s.get("k")).toBeUndefined();
  });

  it("does not hit IDB during the cooldown, then retries and recovers", async () => {
    const { ops, data, state } = fakeIdb();
    let t = 1000;
    const s = createIdbStorage(ops, () => t);
    state.fail = true;
    await s.get("x"); // fails, cooldown starts
    const callsAfterFail = state.calls;
    t += IDB_RETRY_COOLDOWN_MS - 1;
    await s.get("x");
    expect(state.calls).toBe(callsAfterFail); // still cooling down

    state.fail = false;
    data.set("x", "from-idb");
    t += 1; // cooldown elapsed
    expect(await s.get("x")).toBe("from-idb");
    // fully recovered: writes reach IDB again
    await s.set("y", 2);
    expect(data.get("y")).toBe(2);
  });

  it("a failed retry restarts the cooldown", async () => {
    const { ops, state } = fakeIdb();
    let t = 0;
    const s = createIdbStorage(ops, () => t);
    state.fail = true;
    await s.get("x");
    t = IDB_RETRY_COOLDOWN_MS;
    await s.get("x"); // retry fails again
    const calls = state.calls;
    t += 10;
    await s.get("x");
    expect(state.calls).toBe(calls);
  });
});
