import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { IDS, offerById, sampleCatalog } from "../__fixtures__";
import { parseCart } from "../domain/cart";
import { createLocalKv, type LocalKv } from "../platform/localKv";
import { createMemoryStorage } from "../platform/storage";
import { CART_KEY, CartProvider, useCart } from "./CartContext";
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

async function tab(id: string, offer: typeof X, kv: LocalKv) {
  const storage = createMemoryStorage();
  await storage.set(CATALOG_KEY, { catalog, etag: '"v1"', checkedAt: Date.now() });
  const store = new CatalogStore({ storage, fetchFn: () => Promise.reject(new Error("offline")) });
  return render(
    <MemoryRouter>
      <CatalogProvider store={store}>
        <CartProvider kv={kv}>
          <Probe id={id} offer={offer} />
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
    const stored = parseCart(JSON.parse(shared.getItem(CART_KEY) ?? "null"));
    expect(stored.lines.map((l) => l.offerId).sort().join(",")).toBe(both);

    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: CART_KEY, newValue: shared.getItem(CART_KEY) }));
    });
    expect(screen.getByTestId("ids-A").textContent).toBe(both);
    expect(screen.getByTestId("ids-B").textContent).toBe(both);
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
