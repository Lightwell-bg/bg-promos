import { describe, expect, it, vi } from "vitest";
import { Prefs } from "./prefs";
import { createMemoryStorage, type KeyValueStorage } from "./storage";

/** A storage whose get() resolves only when release() is called. */
function slowStorage() {
  const inner = createMemoryStorage();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const kv: KeyValueStorage = {
    get: async <T,>(k: string) => {
      const v = await inner.get<T>(k);
      await gate;
      return v;
    },
    set: (k, v) => inner.set(k, v),
    del: (k) => inner.del(k),
  };
  return { kv, inner, release };
}

describe("Prefs preload", () => {
  it("loads stored values", async () => {
    const kv = createMemoryStorage();
    await kv.set("pref:lang", "ru");
    const p = new Prefs(kv);
    await p.preload(["lang"]);
    expect(p.get("lang", "bg")).toBe("ru");
  });

  it("a set during a slow preload wins, in memory and in storage", async () => {
    const { kv, inner, release } = slowStorage();
    await inner.set("pref:lang", "bg");
    const p = new Prefs(kv);
    const done = p.preload(["lang"]);
    p.set("lang", "ru");
    release();
    await done;
    expect(p.get("lang", "x")).toBe("ru");
    expect(await inner.get("pref:lang")).toBe("ru");
  });

  it("a remove during a slow preload is not undone by the late value", async () => {
    const { kv, inner, release } = slowStorage();
    await inner.set("pref:consent", { choice: "granted", at: 1 });
    const p = new Prefs(kv);
    const done = p.preload(["consent"]);
    p.remove("consent");
    release();
    await done;
    expect(p.get("consent", null)).toBeNull();
  });

  it("notifies subscribers when a late preload applies a value", async () => {
    const { kv, inner, release } = slowStorage();
    await inner.set("pref:lang", "ru");
    const p = new Prefs(kv);
    const cb = vi.fn();
    p.subscribe(cb);
    const done = p.preload(["lang"]);
    expect(cb).not.toHaveBeenCalled();
    release();
    await done;
    expect(cb).toHaveBeenCalled();
    expect(p.get("lang", "bg")).toBe("ru");
  });
});
