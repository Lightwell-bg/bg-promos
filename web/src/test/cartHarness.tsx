import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { sampleCatalog } from "../__fixtures__";
import { CartProvider, CARTS_KEY } from "../data/CartContext";
import { CatalogProvider } from "../data/CatalogContext";
import { CATALOG_KEY, CatalogStore } from "../data/catalogStore";
import type { CartState } from "../domain/cart";
import { initialCarts, type CartsState } from "../domain/carts";
import type { Catalog, Lang } from "../domain/types";
import { LangProvider } from "../i18n/LangContext";
import { createLocalKv } from "../platform/localKv";
import { createMemoryStorage } from "../platform/storage";

interface Opts {
  /** Catalog served from the cache; null = no catalog at all (offline first load). */
  catalog?: Catalog | null;
  /** Active list stored before the app starts. */
  cart?: CartState;
  /** Full multi-list state stored before the app starts (wins over `cart`). */
  carts?: CartsState;
  lang?: Lang;
  route?: string;
}

/** Renders `ui` inside router + language + catalog + cart providers with isolated storage. */
export async function renderWithCart(ui: ReactElement, opts: Opts = {}) {
  const { catalog = sampleCatalog(), cart, carts, lang = "bg", route = "/" } = opts;
  const storage = createMemoryStorage();
  if (catalog) await storage.set(CATALOG_KEY, { catalog, etag: '"v1"', checkedAt: Date.now() });
  const store = new CatalogStore({ storage, fetchFn: () => Promise.reject(new Error("offline")) });
  const kv = createLocalKv({ getStorage: () => window.localStorage });
  if (carts) kv.set(CARTS_KEY, carts);
  else if (cart) kv.set(CARTS_KEY, initialCarts(new Date(), cart));
  const result = render(
    <MemoryRouter initialEntries={[route]}>
      <LangProvider lang={lang}>
        <CatalogProvider store={store}>
          <CartProvider kv={kv}>{ui}</CartProvider>
        </CatalogProvider>
      </LangProvider>
    </MemoryRouter>,
  );
  return { ...result, kv };
}
