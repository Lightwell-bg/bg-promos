import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { sampleCatalog } from "../__fixtures__";
import { CartProvider, CARTS_KEY } from "../data/CartContext";
import { CatalogProvider } from "../data/CatalogContext";
import { ConfigProvider, FALLBACK_CONFIG } from "../data/ConfigContext";
import { CATALOG_KEY, CatalogStore } from "../data/catalogStore";
import type { CartState } from "../domain/cart";
import { initialCarts, type CartsState } from "../domain/carts";
import type { AppConfig, Catalog, Lang } from "../domain/types";
import { prefs } from "../platform/prefs";
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
  /** Runtime config overrides (e.g. telegram_bot); without it the default config (no bot) is used. */
  config?: Partial<AppConfig>;
}

/** Renders `ui` inside router + language + catalog + cart providers with isolated storage. */
export async function renderWithCart(ui: ReactElement, opts: Opts = {}) {
  const { catalog = sampleCatalog(), cart, carts, lang = "bg", route = "/", config } = opts;
  if (config) {
    prefs.set("config", { ...FALLBACK_CONFIG, ...config });
    // the provider's background refresh must fail quietly and keep the preset config
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
  } else {
    prefs.remove("config");
  }
  const storage = createMemoryStorage();
  if (catalog) await storage.set(CATALOG_KEY, { catalog, etag: '"v1"', checkedAt: Date.now() });
  const store = new CatalogStore({ storage, fetchFn: () => Promise.reject(new Error("offline")) });
  const kv = createLocalKv({ getStorage: () => window.localStorage });
  if (carts) kv.set(CARTS_KEY, carts);
  else if (cart) kv.set(CARTS_KEY, initialCarts(new Date(), cart));
  const result = render(
    <MemoryRouter initialEntries={[route]}>
      <LangProvider lang={lang}>
        <ConfigProvider>
          <CatalogProvider store={store}>
            <CartProvider kv={kv}>{ui}</CartProvider>
          </CatalogProvider>
        </ConfigProvider>
      </LangProvider>
    </MemoryRouter>,
  );
  return { ...result, kv };
}
