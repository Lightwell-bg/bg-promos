import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { IDS, offerById, sampleCatalog } from "../__fixtures__";
import { addOffer, EMPTY_CART } from "../domain/cart";
import { activeCart, deleteCart, initialCarts, parseCarts, switchCart, type CartsState } from "../domain/carts";
import { createLocalKv, type LocalKv } from "../platform/localKv";
import { setLockManager } from "../platform/locks";
import { createMemoryStorage } from "../platform/storage";
import { CART_KEY_V1, CARTS_KEY, CartProvider, useCart } from "./CartContext";
import { CatalogProvider } from "./CatalogContext";
import { CATALOG_KEY, CatalogStore } from "./catalogStore";

const catalog = sampleCatalog();
const X = offerById(catalog, IDS.lidlPromo);
const Y = offerById(catalog, IDS.billaPromo);

/** In-memory Storage shared by several "tabs". */
function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  } as unknown as Storage;
}

function Probe({ id, offer }: { id: string; offer: typeof X }) {
  const cart = useCart();
  return (
    <div>
      <button type="button" onClick={() => cart.add(offer)}>
        add-{id}
      </button>
      <span data-testid={`ids-${id}`}>{cart.state.lines.map((l) => l.offerId).sort().join(",")}</span>
    </div>
  );
}

/** Shows the displayed list id and offers a clear button. */
function ClearProbe() {
  const cart = useCart();
  return (
    <div>
      <button type="button" onClick={() => cart.clear()}>
        clear
      </button>
      <span data-testid="shown">{cart.activeId}</span>
    </div>
  );
}

/** Fake navigator.locks: FIFO mutex whose callbacks start asynchronously. */
function fakeLocks() {
  let tail: Promise<unknown> = Promise.resolve();
  let running = 0;
  const fake = {
    names: [] as string[],
    maxConcurrent: 0,
    request<T>(name: string, cb: () => T | Promise<T>): Promise<T> {
      fake.names.push(name);
      const run = tail.then(async () => {
        await Promise.resolve(); // let other tabs queue up before this one runs
        running++;
        fake.maxConcurrent = Math.max(fake.maxConcurrent, running);
        try {
          return await cb();
        } finally {
          running--;
        }
      });
      tail = run.catch(() => undefined);
      return run;
    },
  };
  return fake;
}

async function tab(id: string, offer: typeof X, kv: LocalKv, extra?: ReactNode) {
  const storage = createMemoryStorage();
  await storage.set(CATALOG_KEY, { catalog, etag: '"v1"', checkedAt: Date.now() });
  const store = new CatalogStore({ storage, fetchFn: () => Promise.reject(new Error("offline")) });
  return render(
    <MemoryRouter>
      <CatalogProvider store={store}>
        <CartProvider kv={kv}>
          <Probe id={id} offer={offer} />
          {extra}
        </CartProvider>
      </CatalogProvider>
    </MemoryRouter>,
  );
}

const both = [X.id, Y.id].sort().join(",");

beforeEach(() => window.localStorage.clear());

describe("CartProvider across tabs", () => {
  it("two tabs sharing one storage: no lost update, both see both lines after the storage events", async () => {
    const shared = fakeStorage();
    const kvA = createLocalKv({ getStorage: () => shared });
    const kvB = createLocalKv({ getStorage: () => shared });
    await tab("A", X, kvA);
    await tab("B", Y, kvB);

    await userEvent.click(screen.getByRole("button", { name: "add-A" }));
    await userEvent.click(screen.getByRole("button", { name: "add-B" })); // B has not seen A's event
    const stored = activeCart(parseCarts(JSON.parse(shared.getItem(CARTS_KEY) ?? "null"))).cart;
    expect(stored.lines.map((l) => l.offerId).sort().join(",")).toBe(both);

    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: CARTS_KEY, newValue: shared.getItem(CARTS_KEY) }));
    });
    expect(screen.getByTestId("ids-A").textContent).toBe(both);
    expect(screen.getByTestId("ids-B").textContent).toBe(both);
  });

  it("an action targets the list the tab displays, even if another tab switched the stored active list", async () => {
    const shared = fakeStorage();
    const kvA = createLocalKv({ getStorage: () => shared });
    const kvB = createLocalKv({ getStorage: () => shared });
    const base = initialCarts(new Date(2026, 9, 17));
    const idX = base.activeId;
    const two: CartsState = {
      ...base,
      carts: [
        { ...base.carts[0], cart: addOffer(EMPTY_CART, X) },
        { ...base.carts[0], id: "listY", cart: addOffer(EMPTY_CART, Y) },
      ],
    };
    kvB.set(CARTS_KEY, two); // active = X
    await tab("A", X, kvA, <ClearProbe />);
    expect(screen.getByTestId("shown").textContent).toBe(idX);

    kvB.set(CARTS_KEY, switchCart(two, "listY")); // tab B switches; A gets no event
    await userEvent.click(screen.getByRole("button", { name: "clear" }));

    const stored = parseCarts(JSON.parse(shared.getItem(CARTS_KEY) ?? "null"));
    expect(stored.activeId).toBe("listY");
    expect(stored.carts.find((c) => c.id === idX)?.cart.lines).toHaveLength(0);
    expect(stored.carts.find((c) => c.id === "listY")?.cart.lines.map((l) => l.offerId)).toEqual([Y.id]);
  });

  it("an action on a list deleted in another tab is a no-op and the UI follows the stored active list", async () => {
    const shared = fakeStorage();
    const kvA = createLocalKv({ getStorage: () => shared });
    const kvB = createLocalKv({ getStorage: () => shared });
    const base = initialCarts(new Date(2026, 9, 17));
    const two: CartsState = {
      ...base,
      carts: [
        { ...base.carts[0], cart: addOffer(EMPTY_CART, X) },
        { ...base.carts[0], id: "listY", cart: addOffer(EMPTY_CART, Y) },
      ],
    };
    kvB.set(CARTS_KEY, two);
    await tab("A", X, kvA, <ClearProbe />);
    kvB.set(CARTS_KEY, deleteCart(two, base.activeId)); // X deleted elsewhere
    await userEvent.click(screen.getByRole("button", { name: "clear" }));
    const stored = parseCarts(JSON.parse(shared.getItem(CARTS_KEY) ?? "null"));
    expect(stored.carts.map((c) => c.id)).toEqual(["listY"]);
    expect(stored.carts[0].cart.lines).toHaveLength(1); // Y untouched
    expect(screen.getByTestId("shown").textContent).toBe("listY");
  });

  it("with Web Locks, two tabs acting at the same time keep both additions", async () => {
    const shared = fakeStorage();
    const kvA = createLocalKv({ getStorage: () => shared });
    const kvB = createLocalKv({ getStorage: () => shared });
    const fake = fakeLocks();
    setLockManager(fake);
    try {
      await tab("A", X, kvA);
      await tab("B", Y, kvB);
      await act(async () => {
        screen.getByRole("button", { name: "add-A" }).click();
        screen.getByRole("button", { name: "add-B" }).click();
      });
      await waitFor(() => {
        const stored = activeCart(parseCarts(JSON.parse(shared.getItem(CARTS_KEY) ?? "null"))).cart;
        expect(stored.lines.map((l) => l.offerId).sort().join(",")).toBe(both);
      });
      expect(fake.names).toEqual(["bgpromos-cart", "bgpromos-cart"]);
      expect(fake.maxConcurrent).toBe(1);
    } finally {
      setLockManager(undefined);
    }
  });

  it("when a write fails the in-memory state stays authoritative and the next action builds on it", async () => {
    const m = new Map<string, string>();
    let failing = false;
    const store = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (failing) throw new Error("QuotaExceededError");
        m.set(k, v);
      },
      removeItem: (k: string) => void m.delete(k),
    } as unknown as Storage;
    const kv = createLocalKv({ getStorage: () => store });
    await tab("A", X, kv);
    failing = true; // the stored copy stays at the empty list
    await userEvent.click(screen.getByRole("button", { name: "add-A" }));
    expect(screen.getByTestId("ids-A").textContent).toBe(X.id);
    expect(activeCart(parseCarts(kv.get(CARTS_KEY))).cart.lines).toHaveLength(1);
    cleanup();
    await tab("A", Y, kv);
    await userEvent.click(screen.getByRole("button", { name: "add-A" }));
    expect(screen.getByTestId("ids-A").textContent).toBe(both);
  });

  it("migration drops the v1 key only after the v2 write succeeded", async () => {
    const legacy = addOffer(EMPTY_CART, X);
    for (const failWrite of [true, false]) {
      cleanup();
      const m = new Map<string, string>([[CART_KEY_V1, JSON.stringify(legacy)]]);
      const store = {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => {
          if (failWrite) throw new Error("QuotaExceededError");
          m.set(k, v);
        },
        removeItem: (k: string) => void m.delete(k),
      } as unknown as Storage;
      await tab("A", Y, createLocalKv({ getStorage: () => store }));
      expect(screen.getByTestId("ids-A").textContent).toBe(X.id); // migrated either way
      expect(m.has(CART_KEY_V1)).toBe(failWrite ? true : false);
      expect(m.has(CARTS_KEY)).toBe(!failWrite);
    }
  });

  it("works in memory when the storage is unavailable", async () => {
    const kv = createLocalKv({
      getStorage: () => {
        throw new Error("SecurityError");
      },
    });
    await tab("A", X, kv);
    await userEvent.click(screen.getByRole("button", { name: "add-A" }));
    expect(screen.getByTestId("ids-A").textContent).toBe(X.id);
  });
});
