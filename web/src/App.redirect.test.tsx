import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pinClock, unpinClock } from "./test/fixedClock";
import { IDS, sampleCatalog } from "./__fixtures__";
import { AppRoutes } from "./App";
import { CARTS_KEY, CartProvider } from "./data/CartContext";
import { CatalogProvider } from "./data/CatalogContext";
import { CATALOG_KEY, CatalogStore } from "./data/catalogStore";
import { ConfigProvider } from "./data/ConfigContext";
import { activeCart, parseCarts } from "./domain/carts";
import { NavDepthProvider } from "./hooks/useNavDepth";
import { createLocalKv } from "./platform/localKv";
import { prefs } from "./platform/prefs";
import { createMemoryStorage } from "./platform/storage";
import { MemoryRouter, useLocation } from "react-router-dom";

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search + l.hash}</output>;
}

async function renderApp(entry: string) {
  const storage = createMemoryStorage();
  await storage.set(CATALOG_KEY, { catalog: sampleCatalog(), etag: '"v1"', checkedAt: Date.now() });
  const store = new CatalogStore({ storage, fetchFn: () => Promise.reject(new Error("offline")) });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <ConfigProvider>
        <CatalogProvider store={store}>
          <CartProvider kv={createLocalKv()}>
            <NavDepthProvider>
              <AppRoutes />
            </NavDepthProvider>
            <Where />
          </CartProvider>
        </CatalogProvider>
      </ConfigProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  pinClock();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/"); // the address bar has no fragment: only the router carries it
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
  prefs.remove("lang");
});

afterEach(() => unpinClock());

describe("language redirects keep the fragment", () => {
  for (const entry of ["/cart/import", "/xx/cart/import"]) {
    it(`${entry}#c=... reaches the import page with its payload and imports`, async () => {
      await renderApp(`${entry}#c=1.${IDS.lidlPromo}-2`);
      await waitFor(() => expect(screen.getByTestId("where").textContent).toMatch(/^\/(bg|ru)\/cart$/));
      const stored = activeCart(parseCarts(JSON.parse(window.localStorage.getItem(CARTS_KEY) ?? "null")));
      expect(stored.cart.lines.map((l) => [l.offerId, l.qty])).toEqual([[IDS.lidlPromo, 2]]);
    });
  }

  it("the query string is kept too", async () => {
    await renderApp("/catalog?q=milk#frag");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toMatch(/^\/(bg|ru)\/catalog\?q=milk#frag$/));
  });
});
