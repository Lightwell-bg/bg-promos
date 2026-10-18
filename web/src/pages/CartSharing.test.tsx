import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDS, offerById, sampleCatalog, SAMPLE_TODAY } from "../__fixtures__";
import { CARTS_KEY } from "../data/CartContext";
import { addOffer, EMPTY_CART, type CartState } from "../domain/cart";
import {
  activeCart,
  decodeShare,
  decodeStartParam,
  encodeShare,
  initialCarts,
  parseCarts,
  shareFromHash,
} from "../domain/carts";
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
const pairs = (c: CartState) => c.lines.map((l) => [l.offerId, l.qty]).sort();

function mockClipboard(writeText: () => Promise<void>, execCommand: boolean) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  Object.defineProperty(document, "execCommand", { value: vi.fn(() => execCommand), configurable: true });
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${SAMPLE_TODAY}T09:00:00+03:00`));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(document, "execCommand");
  window.history.replaceState(null, "", "/");
});

describe("share link creation keeps quantities", () => {
  it("t.me startapp link of a list with quantity > 1 decodes back to the same quantities", async () => {
    await renderWithCart(<Cart />, { cart: cartOf([A, 3], [B, 2], [C, 1]), config: { telegram_bot: "promoseubot" } });
    await userEvent.click(await screen.findByRole("button", { name: "Сподели" }));
    const input = (await screen.findByRole("textbox", { name: "Telegram" })) as HTMLInputElement;
    const param = new URL(input.value).searchParams.get("startapp");
    expect(decodeStartParam(param).map((i) => [i.offerId, i.qty]).sort()).toEqual(
      [[A, 3], [B, 2], [C, 1]].sort(),
    );
  });

  it("web form link of a list with quantity > 1 decodes back to the same quantities", async () => {
    await renderWithCart(<Cart />, { cart: cartOf([A, 3], [B, 2]), config: { telegram_bot: null } });
    await userEvent.click(await screen.findByRole("button", { name: "Сподели" }));
    const input = (await screen.findByRole("textbox", { name: "За браузър" })) as HTMLInputElement;
    const items = decodeShare(shareFromHash(new URL(input.value).hash));
    expect(items.map((i) => [i.offerId, i.qty]).sort()).toEqual([[A, 3], [B, 2]].sort());
  });
});

describe("received list", () => {
  const link = `#c=${encodeShare(cartOf([A, 3], [B, 2]))}`;

  it("first launch: exactly one list with the shared quantities", async () => {
    window.history.replaceState(null, "", `/bg/cart/import${link}`);
    await renderWithCart(<Routed />, { route: "/bg/cart/import" });
    await screen.findByText("Количката е заредена от връзката");
    const s = stored();
    expect(s.carts).toHaveLength(1);
    expect(pairs(activeCart(s).cart)).toEqual([[A, 3], [B, 2]].sort());
  });

  it("web share link with utm query: the list is read from the hash and imported", async () => {
    window.history.replaceState(
      null, "", `/bg/cart/import?utm_source=share&utm_medium=cart&utm_campaign=share&utm_content=web${link}`);
    await renderWithCart(<Routed />, { route: "/bg/cart/import" });
    await screen.findByText("Количката е заредена от връзката");
    expect(pairs(activeCart(stored()).cart)).toEqual([[A, 3], [B, 2]].sort());
    expect(window.location.hash).toBe("");
  });

  it("device with history: two lists, own one intact, shared quantities preserved", async () => {
    window.history.replaceState(null, "", `/bg/cart/import${link}`);
    await renderWithCart(<Routed />, {
      route: "/bg/cart/import",
      carts: initialCarts(NOW, cartOf([C, 4])),
    });
    await screen.findByText(/Създадена е нова количка/);
    const s = stored();
    expect(s.carts).toHaveLength(2);
    expect(s.carts[0].origin).toBe("own");
    expect(pairs(s.carts[0].cart)).toEqual([[C, 4]]);
    expect(pairs(s.carts[1].cart)).toEqual([[A, 3], [B, 2]].sort());
  });

  it("the received list survives a reload (app remount reading the same storage)", async () => {
    window.history.replaceState(null, "", `/bg/cart/import${link}`);
    const first = await renderWithCart(<Routed />, {
      route: "/bg/cart/import",
      carts: initialCarts(NOW, cartOf([C, 1])),
    });
    await screen.findByText(/Създадена е нова количка/);
    first.unmount();

    window.history.replaceState(null, "", "/bg/cart");
    await renderWithCart(<Routed />, { route: "/bg/cart" });
    expect(await screen.findByRole("button", { name: /Получена по връзка · \d\d\.\d\d · 5/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Моята количка · 1" })).toBeInTheDocument();
    const s = stored();
    expect(s.carts).toHaveLength(2);
    expect(pairs(s.carts[1].cart)).toEqual([[A, 3], [B, 2]].sort());
  });
});

describe("copy", () => {
  it("success shows the confirmation", async () => {
    await renderWithCart(<Cart />, { cart: cartOf([A, 2]), config: { telegram_bot: null } });
    await userEvent.click(await screen.findByRole("button", { name: "Сподели" }));
    mockClipboard(() => Promise.resolve(), true);
    await userEvent.click(screen.getByRole("button", { name: "Копирай" }));
    expect(await screen.findByText("Връзката е копирана")).toBeInTheDocument();
  });

  it("failure shows the error and keeps the link visible and selectable for manual copy", async () => {
    await renderWithCart(<Cart />, { cart: cartOf([A, 2]), config: { telegram_bot: null } });
    await userEvent.click(await screen.findByRole("button", { name: "Сподели" }));
    const input = (await screen.findByRole("textbox", { name: "За браузър" })) as HTMLInputElement;
    const link = input.value;
    mockClipboard(() => Promise.reject(new Error("denied")), false);
    await userEvent.click(screen.getByRole("button", { name: "Копирай" }));
    expect(await screen.findByText("Не успяхме да споделим количката")).toBeInTheDocument();
    expect(screen.queryByText("Връзката е копирана")).toBeNull();

    const still = screen.getByRole("textbox", { name: "За браузър" }) as HTMLInputElement;
    expect(still).toBeVisible();
    expect(still.value).toBe(link);
    expect(still.readOnly).toBe(true);
    await userEvent.click(still); // focusing selects the whole link
    expect(still.selectionStart).toBe(0);
    expect(still.selectionEnd).toBe(link.length);
  });
});
