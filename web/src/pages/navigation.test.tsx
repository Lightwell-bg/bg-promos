import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDS, sampleCatalog } from "../__fixtures__";
import { AppRoutes } from "../App";
import { CartProvider } from "../data/CartContext";
import { CatalogProvider } from "../data/CatalogContext";
import { CATALOG_KEY, CatalogStore } from "../data/catalogStore";
import { ConfigProvider } from "../data/ConfigContext";
import { NavDepthProvider } from "../hooks/useNavDepth";
import { createLocalKv } from "../platform/localKv";
import { prefs } from "../platform/prefs";
import { createMemoryStorage } from "../platform/storage";
import { pinClock, unpinClock } from "../test/fixedClock";

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
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

const where = () => screen.getByTestId("where").textContent;

beforeEach(() => {
  pinClock();
  window.localStorage.clear(); // cart writes are immediate now: do not leak between tests
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
  prefs.remove("recentQueries");
  prefs.remove("lang");
});
afterEach(() => {
  vi.unstubAllGlobals();
  unpinClock();
});

describe("offer detail Back button", () => {
  it("direct entry + language switch (replace): Back goes to the catalog", async () => {
    await renderApp(`/bg/offer/${IDS.lidlPromo}`);
    await userEvent.click(await screen.findByRole("button", { name: "RU" }));
    await waitFor(() => expect(where()).toBe(`/ru/offer/${IDS.lidlPromo}`));
    await userEvent.click(await screen.findByRole("button", { name: "Назад" }));
    await waitFor(() => expect(where()).toBe("/ru/catalog"));
  });

  it("after an in-app push, Back pops the history", async () => {
    await renderApp("/bg/catalog");
    await screen.findAllByRole("article");
    await new Promise((r) => setTimeout(r, 50)); // let the store settle (cache, then the failed fetch)
    const link = screen.getAllByRole("link").find((a) => a.getAttribute("href")?.includes("/offer/"));
    await userEvent.click(link!);
    await waitFor(() => expect(where()).toContain("/bg/offer/"));
    await userEvent.click(await screen.findByRole("button", { name: "Назад" }));
    await waitFor(() => expect(where()).toBe("/bg/catalog"));
  });
});

describe("cart navigation", () => {
  it("the bottom nav has a cart tab whose badge shows the item count", async () => {
    await renderApp("/bg/catalog");
    await screen.findAllByRole("article");
    const nav = screen.getByRole("navigation", { name: "Основна навигация" });
    const tab = within(nav).getByRole("link", { name: /Количка/ });
    expect(tab).toHaveAttribute("href", "/bg/cart");
    expect(within(nav).queryByTestId("cart-badge")).toBeNull();

    const add = screen.getAllByRole("button", { name: "Добави в количката" })[0];
    await userEvent.click(add);
    expect(within(nav).getByTestId("cart-badge")).toHaveTextContent("1");
    await userEvent.click(screen.getAllByRole("button", { name: "Увеличи количеството" })[0]);
    expect(within(nav).getByTestId("cart-badge")).toHaveTextContent("2");
  });

  it("the cart page is noindex and the flag is removed on other pages", async () => {
    await renderApp("/bg/cart");
    await screen.findByText("Количката е празна");
    await waitFor(() => expect(document.head.querySelector('meta[name="robots"]')).toHaveAttribute("content", "noindex"));
    await userEvent.click(within(screen.getByRole("navigation", { name: "Основна навигация" })).getByRole("link", { name: "Търсене" }));
    await waitFor(() => expect(document.head.querySelector('meta[name="robots"]')).toBeNull());
  });
});

describe("search", () => {
  it("committing an empty value removes q and is not saved as a recent search", async () => {
    await renderApp("/bg/search?q=milka");
    const input = await screen.findByRole("searchbox");
    expect(input).toHaveValue("milka");
    await userEvent.clear(input);
    await userEvent.click(screen.getByRole("button", { name: "Търси" }));
    await waitFor(() => expect(where()).toBe("/bg/search"));
    expect(screen.getByText(/Можете да пишете/)).toBeInTheDocument();
    expect(prefs.get<unknown>("recentQueries", [])).toEqual([]);
  });

  it("?q= on entry is moved into router state and removed from the URL", async () => {
    await renderApp("/bg/search?q=milka");
    const input = await screen.findByRole("searchbox");
    await waitFor(() => expect(where()).toBe("/bg/search"));
    expect(input).toHaveValue("milka");
    expect(document.querySelector('[data-clarity-mask="true"] [role="search"]')).not.toBeNull();
  });

  it("a committed search never appears in the URL; the results stay", async () => {
    await renderApp("/bg/search");
    const input = await screen.findByRole("searchbox");
    await userEvent.type(input, "zzzqqq");
    await userEvent.click(screen.getByRole("button", { name: "Търси" }));
    await waitFor(() => expect(prefs.get<string[]>("recentQueries", [])).toEqual(["zzzqqq"]));
    expect(where()).toBe("/bg/search");
    expect(input).toHaveValue("zzzqqq");
    expect(document.querySelector("[aria-live='polite']")).not.toBeNull();
  });
});
