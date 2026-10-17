import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDS, offerById, sampleCatalog, SAMPLE_TODAY } from "../__fixtures__";
import { CART_KEY_V1, CARTS_KEY } from "../data/CartContext";
import { addOffer, EMPTY_CART, type CartState } from "../domain/cart";
import { activeCart, decodeShare, encodeShare, encodeStartParam, initialCarts, parseCarts, shareFromHash, switchCart } from "../domain/carts";
import { setSharer, webSharer, type ShareData, type ShareResult } from "../platform/share";
import { renderWithCart } from "../test/cartHarness";
import { Cart } from "./Cart";
import { CartImport } from "./CartImport";

const base = sampleCatalog();
const NOW = new Date("2026-10-17T08:00:00Z");
const A = IDS.lidlPromo;
const B = IDS.billaPromo;
const C = IDS.kauflandMultibuy;

function cartOf(...entries: Array<[string, number]>): CartState {
  return entries.reduce((s, [id, q]) => addOffer(s, offerById(base, id), NOW, q), EMPTY_CART);
}

function Routed() {
  return (
    <Routes>
      <Route path="/:lang/cart/import" element={<CartImport />} />
      <Route path="/:lang/cart" element={<Cart />} />
    </Routes>
  );
}

const stored = () => parseCarts(JSON.parse(window.localStorage.getItem(CARTS_KEY) ?? "null"));
const ids = (c: CartState) => c.lines.map((l) => l.offerId).sort();

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${SAMPLE_TODAY}T09:00:00+03:00`));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setSharer(webSharer);
  window.history.replaceState(null, "", "/");
});

describe("storage migration", () => {
  it("moves the old single cart into the v2 key and removes the old key", async () => {
    window.localStorage.setItem(CART_KEY_V1, JSON.stringify(cartOf([A, 2])));
    await renderWithCart(<Cart />);
    expect(await screen.findByTestId("grand-total")).toBeInTheDocument();
    expect(window.localStorage.getItem(CART_KEY_V1)).toBeNull();
    expect(ids(activeCart(stored()).cart)).toEqual([A]);
  });
});

describe("opening a shared link", () => {
  const link = `#c=${encodeShare(cartOf([A, 2], [B, 1]))}`;

  it("a first-time visitor gets the same list", async () => {
    window.history.replaceState(null, "", `/bg/cart/import${link}`);
    const { kv } = await renderWithCart(<Routed />, { route: "/bg/cart/import" });
    expect(await screen.findByText("Количката е заредена от връзката")).toBeInTheDocument();
    expect(await screen.findByTestId("grand-total")).toBeInTheDocument();
    const s = parseCarts(kv.get(CARTS_KEY));
    expect(s.carts).toHaveLength(1);
    expect(ids(activeCart(s).cart)).toEqual([A, B].sort());
    expect(screen.queryByRole("group", { name: "Моите списъци" })).toBeNull(); // single list: no switcher
    expect(window.location.hash).toBe(""); // the fragment is removed
  });

  it("a visitor with a list gets a second list; the own list stays", async () => {
    window.history.replaceState(null, "", `/bg/cart/import${link}`);
    const own = initialCarts(NOW, cartOf([C, 1]));
    await renderWithCart(<Routed />, { route: "/bg/cart/import", carts: own });
    expect(await screen.findByText(/Създадена е нова количка/)).toBeInTheDocument();
    const group = await screen.findByRole("group", { name: "Моите списъци" });
    const chips = within(group).getAllByRole("button");
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent("Моята количка · 1");
    expect(chips[1]).toHaveTextContent(/Получена по връзка · \d\d\.\d\d · 3/);
    expect(chips[1]).toHaveAttribute("aria-pressed", "true");
    const s = stored();
    expect(s.carts).toHaveLength(2);
    expect(ids(s.carts[0].cart)).toEqual([C]);
    expect(s.carts[0].origin).toBe("own");
  });

  it("reopening the same link does not create another list", async () => {
    window.history.replaceState(null, "", `/bg/cart/import${link}`);
    const own = initialCarts(NOW, cartOf([C, 1]));
    const first = await renderWithCart(<Routed />, { route: "/bg/cart/import", carts: own });
    await screen.findByText(/Създадена е нова количка/);
    first.unmount();
    window.history.replaceState(null, "", `/bg/cart/import${link}`);
    await renderWithCart(<Routed />, { route: "/bg/cart/import" });
    expect(await screen.findByText("Тази количка вече е отворена")).toBeInTheDocument();
    expect(stored().carts).toHaveLength(2);
  });

  it("a link without available products reports it", async () => {
    window.history.replaceState(null, "", `/bg/cart/import#c=1.${IDS.ended}-1_ffffffffffff-1`);
    await renderWithCart(<Routed />, { route: "/bg/cart/import" });
    expect(await screen.findByText(/Връзката не съдържа налични продукти/)).toBeInTheDocument();
    expect(screen.getByText(/2 продукта вече не са в промоция/)).toBeInTheDocument();
  });

  it("garbage in the fragment is handled", async () => {
    window.history.replaceState(null, "", "/bg/cart/import#c=%E0%A4%A");
    await renderWithCart(<Routed />, { route: "/bg/cart/import" });
    expect(await screen.findByText(/Връзката не съдържа налични продукти/)).toBeInTheDocument();
  });

  it("without a catalog it asks for the internet and can retry", async () => {
    window.history.replaceState(null, "", `/bg/cart/import${link}`);
    await renderWithCart(<Routed />, { route: "/bg/cart/import", catalog: null });
    expect(await screen.findByText("Необходим е интернет, за да се отвори споделената количка")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Опитай отново" })).toBeInTheDocument();
    // Nothing was imported: the stored state is only the untouched initial (empty) list.
    const stored = parseCarts(JSON.parse(window.localStorage.getItem(CARTS_KEY) ?? "null"));
    expect(stored.carts).toHaveLength(1);
    expect(activeCart(stored).cart.lines).toHaveLength(0);
  });
});

describe("sharing and managing lists", () => {
  it("the share button always shows the link panel (Telegram webviews have no share sheet)", async () => {
    let shared: ShareData | null = null;
    setSharer({
      async share(d): Promise<ShareResult> {
        shared = d;
        return "copied";
      },
    });
    await renderWithCart(<Cart />, { cart: cartOf([A, 2], [B, 1]) });
    await userEvent.click(await screen.findByRole("button", { name: "Сподели" }));
    // the panel is visible without any share/clipboard API call
    expect(shared).toBeNull();
    const input = (await screen.findByRole("textbox", { name: "За браузър" })) as HTMLInputElement;
    // no bot configured: only the browser block, no Telegram block or share link
    expect(screen.queryByRole("textbox", { name: "Telegram" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Изпрати в Telegram" })).toBeNull();
    expect(screen.getByRole("button", { name: "Копирай" })).toBeInTheDocument();
    const url = new URL(input.value);
    expect(url.pathname).toBe("/bg/cart/import");
    expect(decodeShare(shareFromHash(url.hash)).sort((x, y) => x.offerId.localeCompare(y.offerId))).toEqual(
      [
        { offerId: A, qty: 2 },
        { offerId: B, qty: 1 },
      ].sort((x, y) => x.offerId.localeCompare(y.offerId)),
    );
  });

  it("with a configured bot there are two blocks: a t.me Mini App link (used by Telegram share) and a browser link", async () => {
    await renderWithCart(<Cart />, { cart: cartOf([A, 2], [B, 1]), config: { telegram_bot: "promoseubot" } });
    await userEvent.click(await screen.findByRole("button", { name: "Сподели" }));
    const web = (await screen.findByRole("textbox", { name: "За браузър" })) as HTMLInputElement;
    expect(new URL(web.value).pathname).toBe("/bg/cart/import");
    const input = screen.getByRole("textbox", { name: "Telegram" }) as HTMLInputElement;
    expect(input.value).toMatch(/^https:\/\/t\.me\/promoseubot\?startapp=c1_[0-9a-f]{12}/);
    expect(input.value).toBe(`https://t.me/promoseubot?startapp=${encodeStartParam(cartOf([A, 2], [B, 1]))}`);
    const tg = screen.getByRole("link", { name: "Изпрати в Telegram" }) as HTMLAnchorElement;
    const tgUrl = new URL(tg.href);
    expect(tgUrl.origin + tgUrl.pathname).toBe("https://t.me/share/url");
    expect(tgUrl.searchParams.get("url")).toBe(input.value);
    expect(tgUrl.searchParams.get("text")).toBe("Моята количка");
    expect(screen.queryByText(/ще се отвори в браузъра/)).toBeNull();
  });

  it("a list too long for startapp falls back to the web link with a note", async () => {
    const first = cartOf([A, 1]).lines[0];
    const lines = Array.from({ length: 40 }, (_, i) => ({ ...first, offerId: i.toString(16).padStart(12, "0") }));
    await renderWithCart(<Cart />, { cart: { ...EMPTY_CART, lines }, config: { telegram_bot: "promoseubot" } });
    await userEvent.click(await screen.findByRole("button", { name: "Сподели" }));
    const input = (await screen.findByRole("textbox", { name: "За браузър" })) as HTMLInputElement;
    expect(screen.queryByRole("textbox", { name: "Telegram" })).toBeNull();
    expect(new URL(input.value).pathname).toBe("/bg/cart/import");
    expect(screen.getByText("Списъкът е дълъг — връзката ще се отвори в браузъра")).toBeInTheDocument();
  });

  it("without a configured bot the web link and the note are shown", async () => {
    await renderWithCart(<Cart />, { cart: cartOf([A, 2]), config: { telegram_bot: null } });
    await userEvent.click(await screen.findByRole("button", { name: "Сподели" }));
    const input = (await screen.findByRole("textbox", { name: "За браузър" })) as HTMLInputElement;
    expect(new URL(input.value).pathname).toBe("/bg/cart/import");
    expect(screen.getByText("Списъкът е дълъг — връзката ще се отвори в браузъра")).toBeInTheDocument();
  });

  it("a failed copy shows the error text in its block and leaves the link in place", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("no")) }, configurable: true });
    Object.defineProperty(document, "execCommand", { value: vi.fn(() => false), configurable: true });
    await renderWithCart(<Cart />, { cart: cartOf([A, 2]), config: { telegram_bot: "promoseubot" } });
    await userEvent.click(await screen.findByRole("button", { name: "Сподели" }));
    const web = within(await screen.findByRole("group", { name: "За браузър" }));
    await userEvent.click(web.getByRole("button", { name: "Копирай" }));
    expect(await web.findByText("Не успяхме да споделим количката")).toBeInTheDocument();
    expect(web.getByRole("textbox")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Telegram" })).queryByRole("status")).toBeNull();
    Reflect.deleteProperty(navigator, "clipboard");
    Reflect.deleteProperty(document, "execCommand");
  });

  it("no share button for an empty list", async () => {
    await renderWithCart(<Cart />);
    await screen.findByText("Количката е празна");
    expect(screen.queryByRole("button", { name: "Сподели" })).toBeNull();
  });

  function twoLists() {
    const s = initialCarts(NOW, cartOf([C, 1]));
    const other = {
      id: "cother",
      name: null,
      origin: "shared" as const,
      createdAt: NOW.toISOString(),
      importKey: "k",
      cart: cartOf([A, 1], [B, 1]),
    };
    return switchCart({ ...s, carts: [...s.carts, other] }, s.activeId);
  }

  it("switch, rename and delete a list", async () => {
    await renderWithCart(<Cart />, { carts: twoLists() });
    const group = await screen.findByRole("group", { name: "Моите списъци" });
    const [mine, shared] = within(group).getAllByRole("button");
    expect(mine).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(shared);
    await waitFor(() => expect(stored().activeId).toBe("cother"));
    expect(screen.getByText("Артикули: 2")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Преименувай" }));
    const input = screen.getByRole("textbox", { name: "Име на списъка" });
    expect(input).toHaveAttribute("maxlength", "40");
    await userEvent.type(input, "За събота{Enter}");
    expect(await screen.findByRole("button", { name: /За събота · 2/ })).toBeInTheDocument();
    expect(stored().carts[1].name).toBe("За събота");

    await userEvent.click(screen.getByRole("button", { name: "Изтрий списъка" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Изтрий списъка" }));
    await waitFor(() => expect(stored().carts).toHaveLength(1));
    expect(stored().activeId).not.toBe("cother");
    expect(ids(activeCart(stored()).cart)).toEqual([C]);
    expect(screen.queryByRole("group", { name: "Моите списъци" })).toBeNull();
  });

  it("a single list has no switcher and no list actions", async () => {
    const s = twoLists();
    await renderWithCart(<Cart />, { carts: { ...s, carts: [s.carts[0]] } });
    await screen.findByTestId("grand-total");
    // single list: no switcher, so delete through the context-less state is not offered
    expect(screen.queryByRole("button", { name: "Изтрий списъка" })).toBeNull();
  });
});

describe("share button limits", () => {
  function bigCart(n: number): CartState {
    const first = cartOf([A, 1]).lines[0];
    const lines = Array.from({ length: n }, (_, i) => ({ ...first, offerId: i.toString(16).padStart(12, "0") }));
    return { ...EMPTY_CART, lines };
  }

  it("a list over 300 lines cannot be shared: disabled with an explanation", async () => {
    await renderWithCart(<Cart />, { cart: bigCart(301) });
    const btn = await screen.findByRole("button", { name: "Сподели" });
    expect(btn).toBeDisabled();
    expect(screen.getByText("Списъкът е твърде дълъг за споделяне (макс. 300 позиции)")).toBeInTheDocument();
  });

  it("exactly 300 lines can still be shared", async () => {
    await renderWithCart(<Cart />, { cart: bigCart(300) });
    expect(await screen.findByRole("button", { name: "Сподели" })).toBeEnabled();
    expect(screen.queryByText(/твърде дълъг/)).toBeNull();
  });
});
