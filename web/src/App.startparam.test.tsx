import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDS, sampleCatalog } from "./__fixtures__";
import { AppRoutes, StartParamGate } from "./App";
import { CARTS_KEY, CartProvider } from "./data/CartContext";
import { CatalogProvider } from "./data/CatalogContext";
import { CATALOG_KEY, CatalogStore } from "./data/catalogStore";
import { ConfigProvider } from "./data/ConfigContext";
import { initialCarts, parseCarts } from "./domain/carts";
import { NavDepthProvider } from "./hooks/useNavDepth";
import { createLocalKv } from "./platform/localKv";
import { prefs } from "./platform/prefs";
import { createMemoryStorage } from "./platform/storage";

const A = IDS.lidlPromo;
const B = IDS.billaPromo;
const PARAM = `c1_${A}-2_${B}`;

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search + l.hash}</output>;
}

async function renderApp() {
  const storage = createMemoryStorage();
  await storage.set(CATALOG_KEY, { catalog: sampleCatalog(), etag: '"v1"', checkedAt: Date.now() });
  const store = new CatalogStore({ storage, fetchFn: () => Promise.reject(new Error("offline")) });
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <ConfigProvider>
        <CatalogProvider store={store}>
          <CartProvider kv={createLocalKv()}>
            <NavDepthProvider>
              <StartParamGate>
                <AppRoutes />
              </StartParamGate>
            </NavDepthProvider>
            <Where />
          </CartProvider>
        </CatalogProvider>
      </ConfigProvider>
    </MemoryRouter>,
  );
}

const stored = () => parseCarts(JSON.parse(window.localStorage.getItem(CARTS_KEY) ?? "null"));
const pairs = (c: { cart: { lines: { offerId: string; qty: number }[] } }) =>
  c.cart.lines.map((l) => [l.offerId, l.qty]).sort();

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
  prefs.remove("lang");
  prefs.remove("config");
});

describe("Telegram start parameter intake", () => {
  it("first ever launch: the shared list is the only list; the parameter is stripped from the query", async () => {
    window.history.replaceState(null, "", `/?tgWebAppStartParam=${PARAM}&x=1`);
    await renderApp();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toMatch(/^\/(bg|ru)\/cart$/));
    const s = stored();
    expect(s.carts).toHaveLength(1);
    expect(pairs(s.carts[0])).toEqual([[A, 2], [B, 1]].sort());
    expect(window.location.search).toBe("?x=1");
  });

  it("works from the hash too and keeps the other hash parameters", async () => {
    window.history.replaceState(null, "", `/#tgWebAppData=abc%3D1&tgWebAppStartParam=${PARAM}&tgWebAppVersion=8`);
    await renderApp();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toMatch(/^\/(bg|ru)\/cart$/));
    expect(stored().carts).toHaveLength(1);
    expect(window.location.hash).toBe("#tgWebAppData=abc%3D1&tgWebAppVersion=8");
  });

  it("the device was used before (even an empty list): own list preserved, shared list added", async () => {
    window.localStorage.setItem(CARTS_KEY, JSON.stringify(initialCarts(new Date("2026-10-17T08:00:00Z"))));
    window.history.replaceState(null, "", `/?tgWebAppStartParam=${PARAM}`);
    await renderApp();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toMatch(/^\/(bg|ru)\/cart$/));
    await waitFor(() => expect(stored().carts).toHaveLength(2));
    const s = stored();
    expect(s.carts[0].origin).toBe("own");
    expect(s.carts[0].cart.lines).toHaveLength(0);
    expect(s.carts[1].origin).toBe("shared");
    expect(pairs(s.carts[1])).toEqual([[A, 2], [B, 1]].sort());
    expect(window.location.search).toBe("");
  });

  it("an invalid parameter is ignored: normal language redirect, nothing imported, URL untouched", async () => {
    window.history.replaceState(null, "", "/?tgWebAppStartParam=garbage");
    await renderApp();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toMatch(/^\/(bg|ru)$/));
    expect(window.location.search).toBe("?tgWebAppStartParam=garbage");
    expect(stored().carts[0].cart.lines).toHaveLength(0);
  });
});
