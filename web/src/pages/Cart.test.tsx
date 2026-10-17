import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDS, offerById, sampleCatalog, SAMPLE_TODAY } from "../__fixtures__";
import { addOffer, EMPTY_CART, type CartState } from "../domain/cart";
import type { Offer } from "../domain/types";
import { renderWithCart } from "../test/cartHarness";
import { Cart } from "./Cart";

const base = sampleCatalog();
const offer = (id: string): Offer => offerById(base, id);
const NOW = new Date("2026-10-17T08:00:00Z");

function cartOf(...entries: Array<[Offer, number]>): CartState {
  return entries.reduce((s, [o, q]) => addOffer(s, o, NOW, q), EMPTY_CART);
}

const norm = (s: string | null) => (s ?? "").replace(/ /g, " ");
const sub = async (chain: string) => norm((await screen.findByTestId(`subtotal-${chain}`)).textContent);

beforeEach(() => {
  window.localStorage.clear();
  // Only Date is faked: "today" is the sample's day, timers stay real for user-event.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${SAMPLE_TODAY}T09:00:00+03:00`));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Cart page", () => {
  it("groups lines by chain in the fixed order with subtotals and a grand total", async () => {
    await renderWithCart(<Cart />, {
      cart: cartOf([offer(IDS.billaPromo), 1], [offer(IDS.lidlPromo), 2], [offer(IDS.kauflandMultibuy), 1]),
    });
    const sections = await screen.findAllByRole("region");
    expect(sections.map((s) => s.getAttribute("aria-label"))).toEqual(["Lidl", "Kaufland", "BILLA"]);
    expect(await sub("lidl")).toBe("3,18 €");
    expect(await sub("kaufland")).toBe("2,49 €"); // one unit: the regular price, the 2-for deal is not reached
    expect(await sub("billa")).toBe("8,99 €");
    expect(norm(screen.getByTestId("grand-total").textContent)).toBe("14,66 €");
    expect(screen.getByText("Артикули: 4")).toBeInTheDocument();
    expect(screen.getByText("Цените са ориентировъчни; валидна е цената в магазина.")).toBeInTheDocument();
    // multibuy hint
    expect(screen.getByText("Добавете още 1 бр. за промоцията (при покупка на 2 бр.)")).toBeInTheDocument();
  });

  it("the quantity stepper changes the line and the totals; minus at 1 removes the line", async () => {
    await renderWithCart(<Cart />, { cart: cartOf([offer(IDS.lidlPromo), 2]) });
    expect(await sub("lidl")).toBe("3,18 €");
    await userEvent.click(screen.getByRole("button", { name: "Увеличи количеството" }));
    expect(await sub("lidl")).toBe("4,77 €");
    await userEvent.click(screen.getByRole("button", { name: "Намали количеството" }));
    await userEvent.click(screen.getByRole("button", { name: "Намали количеството" }));
    expect(await sub("lidl")).toBe("1,59 €");
    await userEvent.click(screen.getByRole("button", { name: "Намали количеството" }));
    expect(await screen.findByText("Количката е празна")).toBeInTheDocument();
  });

  it("ended line: not counted, notice, and a replacement can be accepted", async () => {
    const catalog = sampleCatalog();
    const fresh = structuredClone(offerById(catalog, IDS.ended));
    fresh.id = "newer000001";
    fresh.valid_from = "2026-10-16";
    fresh.valid_to = "2026-10-30";
    fresh.prices = [{ ...fresh.prices[0], total_cents: 89, per_item_cents: 89 }];
    fresh.best = fresh.prices[0];
    catalog.offers.push(fresh);
    await renderWithCart(<Cart />, { catalog, cart: cartOf([offerById(catalog, IDS.ended), 2]) });

    expect(await screen.findByText("Промоцията е изтекла — не е включено в сумата")).toBeInTheDocument();
    expect(screen.getByText(/Има нова промоция: 0,89/)).toBeInTheDocument();
    expect(norm(screen.getByTestId("grand-total").textContent)).toBe("0,00 €");
    expect(screen.getByText("Не са включени: 1")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Замени" }));
    await waitFor(() => expect(screen.queryByText("Промоцията е изтекла — не е включено в сумата")).toBeNull());
    expect(await sub("kaufland")).toBe("1,78 €"); // quantity 2 kept, new price
  });

  it("price changed: shows was/now and OK accepts the new price", async () => {
    const catalog = sampleCatalog();
    const cart = cartOf([offerById(catalog, IDS.lidlPromo), 1]);
    const o = offerById(catalog, IDS.lidlPromo);
    o.prices = o.prices.map((p) => (p.kind === "promo" ? { ...p, total_cents: 139, per_item_cents: 139 } : p));
    await renderWithCart(<Cart />, { catalog, cart });

    expect(await screen.findByText("Цената се промени: беше 1,59 €, сега 1,39 €")).toBeInTheDocument();
    expect(await sub("lidl")).toBe("1,39 €");
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(screen.queryByText(/Цената се промени/)).toBeNull());
    expect(await sub("lidl")).toBe("1,39 €");
  });

  it("upcoming line is counted and shows the start date", async () => {
    await renderWithCart(<Cart />, { cart: cartOf([offer(IDS.upcoming), 1]) });
    expect(await screen.findByText("Промоцията започва на 19.10")).toBeInTheDocument();
    expect(await sub("lidl")).toBe("39,99 €");
  });

  it("an upcoming line whose price changed shows both the upcoming and the price-changed notices", async () => {
    const catalog = sampleCatalog();
    const cart = cartOf([offerById(catalog, IDS.upcoming), 1]);
    const o = offerById(catalog, IDS.upcoming);
    o.prices = [{ ...o.prices[0], kind: "promo", program: null, min_qty: 1, total_cents: 3499, per_item_cents: 3499 }];
    o.regular_cents = null;
    await renderWithCart(<Cart />, { catalog, cart });

    expect(await screen.findByText("Промоцията започва на 19.10")).toBeInTheDocument();
    expect(screen.getByText("Цената се промени: беше 39,99 €, сега 34,99 €")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(screen.queryByText(/Цената се промени/)).toBeNull());
    expect(screen.getByText("Промоцията започва на 19.10")).toBeInTheDocument();
  });

  it("clear all asks for an in-app confirmation (no window.confirm)", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    await renderWithCart(<Cart />, { cart: cartOf([offer(IDS.lidlPromo), 1]) });
    await userEvent.click(await screen.findByRole("button", { name: "Изчисти" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Да изчистя ли количката?")).toBeInTheDocument();

    // cancel keeps the cart
    await userEvent.click(within(dialog).getByRole("button", { name: "Отказ" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("grand-total")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Изчисти" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Изчисти" }));
    expect(await screen.findByText("Количката е празна")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Каталог" })).toHaveAttribute("href", "/bg/catalog");
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("clear store removes only that chain after confirmation", async () => {
    await renderWithCart(<Cart />, { cart: cartOf([offer(IDS.lidlPromo), 1], [offer(IDS.billaPromo), 1]) });
    const lidl = await screen.findByRole("region", { name: "Lidl" });
    await userEvent.click(within(lidl).getByRole("button", { name: "Изчисти магазина" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Изчисти" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Lidl" })).toBeNull());
    expect(screen.getByRole("region", { name: "BILLA" })).toBeInTheDocument();
  });

  it("the card is on by default (loyalty price) and unchecking switches to the regular price", async () => {
    await renderWithCart(<Cart />, { cart: cartOf([offer(IDS.lidlPlus), 1]) });
    const box = screen.getByRole("checkbox", { name: "Имам карта Lidl Plus" });
    expect(box).toBeChecked();
    expect(await sub("lidl")).toBe("0,99 €");
    expect(norm(screen.getByTestId("grand-total").textContent)).toBe("0,99 €");
    expect(screen.getByText("Цените са с карта за лоялност, където има такава.")).toBeInTheDocument();
    await userEvent.click(box);
    expect(box).not.toBeChecked();
    expect(await sub("lidl")).toBe("1,59 €");
    expect(screen.queryByText("Цените са с карта за лоялност, където има такава.")).toBeNull();
  });

  it("card-only line is counted by default and excluded, with a hint, only after unchecking the card", async () => {
    await renderWithCart(<Cart />, { cart: cartOf([offer(IDS.cardNoRegular), 1]) });
    expect(await sub("lidl")).toBe("0,85 €");
    expect(screen.queryByText("Не са включени: 1")).toBeNull();
    await userEvent.click(screen.getByRole("checkbox", { name: "Имам карта Lidl Plus" }));
    expect(await screen.findByText("Цена само с карта — включете „Имам карта“")).toBeInTheDocument();
    expect(screen.getByText("Не са включени: 1")).toBeInTheDocument();
  });

  it("without a catalog (offline first load) prices come from the snapshot and are marked unchecked", async () => {
    await renderWithCart(<Cart />, {
      catalog: null,
      cart: cartOf([offer(IDS.lidlPromo), 1]),
    });
    expect(await screen.findByText("Цените не са проверени")).toBeInTheDocument();
    expect(await sub("lidl")).toBe("1,59 €");
    // the product name is plain text (the offer is not known), not a link
    expect(screen.queryByRole("link", { name: /Pilos/ })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Имам карта Lidl Plus" })).toBeChecked();
  });

  it("renders in Russian", async () => {
    await renderWithCart(<Cart />, { lang: "ru", cart: cartOf([offer(IDS.lidlPromo), 1]) });
    expect(await screen.findByRole("heading", { name: "Моя корзина" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "У меня есть карта Lidl Plus" })).toBeInTheDocument();
    expect(screen.getByText("Итого по магазину")).toBeInTheDocument();
  });

  it("links to the offer detail when the offer still exists", async () => {
    await renderWithCart(<Cart />, { cart: cartOf([offer(IDS.lidlPromo), 1]) });
    const link = await screen.findByRole("link", { name: /Pilos/ });
    expect(link).toHaveAttribute("href", `/bg/offer/${IDS.lidlPromo}`);
  });

  it("empty cart shows the empty state", async () => {
    await renderWithCart(<Cart />);
    expect(await screen.findByText("Количката е празна")).toBeInTheDocument();
  });
});
