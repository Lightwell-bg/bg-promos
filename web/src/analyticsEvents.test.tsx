// Events of docs/ANALYTICS.md at their call sites: one logical action -> one event, safe props only.
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDS, offerById, sampleCatalog } from "./__fixtures__";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useCart } from "./data/CartContext";
import { EMPTY_CART, addOffer } from "./domain/cart";
import { OfferDetail } from "./pages/OfferDetail";
import { Cart } from "./pages/Cart";
import { Search } from "./pages/Search";
import { reportAppError } from "./platform/analytics";
import { flush, getSessionInfo, resetInsightsForTests, startInsights } from "./platform/insights";
import { renderWithCart } from "./test/cartHarness";

interface Sent {
  name: string;
  event_id: string;
  props: Record<string, unknown>;
}
let sent: Sent[] = [];

function stubFetch(opts: { fail?: boolean } = {}) {
  sent = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (opts.fail) throw new TypeError("network");
    const body = init?.body ? JSON.parse(init.body as string) : {};
    if (url.endsWith("/analytics/session")) {
      return { ok: true, status: 200, json: async () => ({ token: "t", visitor_id: "v_0123456789abcdef0123" }) } as Response;
    }
    if (url.endsWith("/analytics/events")) {
      sent.push(...body.events);
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", fn);
}

async function begin() {
  startInsights("bg");
  await waitFor(() => expect(getSessionInfo()).not.toBeNull());
}

async function drain(): Promise<Sent[]> {
  await act(async () => {
    await flush();
  });
  const out = sent;
  sent = [];
  return out;
}

const base = sampleCatalog();
const A = offerById(base, IDS.lidlPromo);
const B = offerById(base, IDS.billaPromo);
const KG = { ...offerById(base, IDS.kauflandOnePlusOne), id: "kgoffer00001", sale_unit: "kg" as const };

function Probe() {
  const cart = useCart();
  return (
    <div>
      <button onClick={() => cart.add(A)}>add</button>
      <button onClick={() => cart.setQty(A.id, 3)}>qty3</button>
      <button onClick={() => cart.setQty(A.id, 0)}>qty0</button>
      <button onClick={() => cart.remove(A.id)}>remove</button>
      <button onClick={() => cart.setCard("lidl", false)}>card-off</button>
      <button onClick={() => cart.add(KG)}>add-kg</button>
      <button onClick={() => cart.setGrams(KG.id, 1500)}>g1500</button>
      <button onClick={() => cart.setGrams(KG.id, 50)}>g50</button>
      <span data-testid="ids">{cart.state.lines.map((l) => l.offerId).join(",")}</span>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  resetInsightsForTests();
});
afterEach(() => {
  resetInsightsForTests();
  vi.unstubAllGlobals();
});

describe("cart events", () => {
  it("cart_add / cart_qty / card_toggle / cart_remove with ids and enums only", async () => {
    await renderWithCart(<Probe />);
    stubFetch();
    await begin();
    await userEvent.click(screen.getByText("add"));
    await userEvent.click(screen.getByText("qty3"));
    await userEvent.click(screen.getByText("card-off"));
    await userEvent.click(screen.getByText("qty0"));
    const ev = await drain();
    expect(ev.map((e) => e.name)).toEqual(["cart_add", "cart_qty", "card_toggle", "cart_remove"]);
    expect(ev[0].props).toEqual({ offer_id: A.id, chain: A.chain, category: A.category });
    expect(ev[1].props).toEqual({ offer_id: A.id, chain: A.chain, delta: 2, unit: "piece" });
    expect(ev[2].props).toEqual({ chain: "lidl", on: false });
    expect(ev[3].props).toEqual({ offer_id: A.id, chain: A.chain, category: A.category });
    expect(new Set(ev.map((e) => e.event_id)).size).toBe(4);
    expect(JSON.stringify(ev)).not.toContain(A.name);
  });

  it("weight lines report a gram delta; going below the minimum is a removal", async () => {
    await renderWithCart(<Probe />);
    stubFetch();
    await begin();
    await userEvent.click(screen.getByText("add-kg"));
    await userEvent.click(screen.getByText("g1500"));
    await userEvent.click(screen.getByText("g50"));
    const ev = await drain();
    expect(ev.map((e) => e.name)).toEqual(["cart_add", "cart_qty", "cart_remove"]);
    expect(ev[1].props).toEqual({ offer_id: KG.id, chain: KG.chain, delta: 500, unit: "g" });
  });

  it("an unreachable analytics endpoint does not affect the cart", async () => {
    await renderWithCart(<Probe />);
    stubFetch({ fail: true });
    startInsights("bg");
    await userEvent.click(screen.getByText("add"));
    await userEvent.click(screen.getByText("qty3"));
    expect(screen.getByTestId("ids")).toHaveTextContent(A.id);
    const stored = JSON.parse(localStorage.getItem("bgpromos:carts:v2") as string);
    expect(stored.carts[0].cart.lines[0].qty).toBe(3);
  });
});

describe("share events", () => {
  const cart = [A, B].reduce((s, o) => addOffer(s, o, new Date("2026-10-17T08:00:00Z"), 1), EMPTY_CART);

  function mockClipboard(ok: boolean) {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: ok ? async () => undefined : async () => Promise.reject(new Error("denied")) },
      configurable: true,
    });
    Object.defineProperty(document, "execCommand", { value: vi.fn(() => ok), configurable: true });
  }
  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
    Reflect.deleteProperty(document, "execCommand");
  });

  it("share_link_created when the panel opens, share_copy ok and fail", async () => {
    await renderWithCart(<Cart />, { cart, config: { telegram_bot: "promoseubot" } });
    stubFetch();
    await begin();
    await userEvent.click(await screen.findByRole("button", { name: "Сподели" }));
    mockClipboard(true);
    await userEvent.click((await screen.findAllByRole("button", { name: "Копирай" }))[0]);
    mockClipboard(false);
    await userEvent.click((await screen.findAllByRole("button", { name: "Копирай" }))[1]);
    const ev = await drain();
    expect(ev.map((e) => e.name)).toEqual(["share_link_created", "share_copy", "share_copy"]);
    expect(ev[0].props).toEqual({ lines: 2, telegram: true });
    expect(ev[1].props).toEqual({ block: "tg", ok: true });
    expect(ev[2].props).toEqual({ block: "web", ok: false });
    expect(JSON.stringify(ev)).not.toMatch(/t\.me|promos\.centerai|#c=/);
  });

  it("the share panel and list lines are masked for Clarity", async () => {
    const { container } = await renderWithCart(<Cart />, { cart, config: { telegram_bot: null } });
    await userEvent.click(await screen.findByRole("button", { name: "Сподели" }));
    expect(container.querySelectorAll('li[data-clarity-mask="true"]').length).toBe(2);
    expect(container.querySelector('[role="region"][data-clarity-mask="true"]')).not.toBeNull();
  });
});

describe("search and offer events", () => {
  it("search: the query text goes in only when there are no results", async () => {
    stubFetch();
    await begin();
    await renderWithCart(<Search />, { route: "/bg/search?q=zzzqqq" });
    await screen.findByText(/Нищо не е намерено/);
    const ev = (await drain()).filter((e) => e.name === "search");
    expect(ev).toHaveLength(1);
    expect(ev[0].props).toEqual({ len: 6, results: 0, query: "zzzqqq" });
  });

  it("search with results sends no query text", async () => {
    stubFetch();
    await begin();
    await renderWithCart(<Search />, { route: "/bg/search?q=мляко" });
    await screen.findByText(/Намерени: [1-9]/);
    const ev = (await drain()).filter((e) => e.name === "search");
    expect(ev).toHaveLength(1);
    expect(ev[0].props.results as number).toBeGreaterThan(0);
    expect(ev[0].props.len).toBe(5);
    expect(ev[0].props).not.toHaveProperty("query");
  });

  it("offer_view is sent once per view even under StrictMode", async () => {
    stubFetch();
    await begin();
    await renderWithCart(
      <StrictMode>
        <Routes>
          <Route path="/:lang/offer/:id" element={<OfferDetail />} />
        </Routes>
      </StrictMode>,
      { route: `/bg/offer/${A.id}` },
    );
    await screen.findByRole("heading", { level: 1 });
    const ev = (await drain()).filter((e) => e.name === "offer_view");
    expect(ev).toHaveLength(1);
    expect(ev[0].props).toEqual({ offer_id: A.id, chain: A.chain, category: A.category });
  });
});

describe("app_error", () => {
  const Boom = (): never => {
    throw new TypeError("secret message with a name Ivan");
  };

  it("ErrorBoundary reports the class name and place only", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    stubFetch();
    await begin();
    await renderWithCart(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    const ev = (await drain()).filter((e) => e.name === "app_error");
    expect(ev[0].props).toEqual({ name: "TypeError", where: "boundary" });
    expect(JSON.stringify(ev)).not.toContain("Ivan");
    vi.restoreAllMocks();
  });

  it("reportAppError never sends the message", async () => {
    stubFetch();
    await begin();
    reportAppError(new RangeError("password=hunter2"), "window");
    const ev = await drain();
    expect(ev).toHaveLength(1);
    expect(ev[0].props).toEqual({ name: "RangeError", where: "window" });
  });
});
