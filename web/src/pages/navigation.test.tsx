import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDS, sampleCatalog } from "../__fixtures__";
import { AppRoutes } from "../App";
import { CatalogProvider } from "../data/CatalogContext";
import { CATALOG_KEY, CatalogStore } from "../data/catalogStore";
import { ConfigProvider } from "../data/ConfigContext";
import { NavDepthProvider } from "../hooks/useNavDepth";
import { prefs } from "../platform/prefs";
import { createMemoryStorage } from "../platform/storage";

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
          <NavDepthProvider>
            <AppRoutes />
          </NavDepthProvider>
          <Where />
        </CatalogProvider>
      </ConfigProvider>
    </MemoryRouter>,
  );
}

const where = () => screen.getByTestId("where").textContent;

beforeEach(() => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
  prefs.remove("recentQueries");
  prefs.remove("lang");
});
afterEach(() => vi.unstubAllGlobals());

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
});
