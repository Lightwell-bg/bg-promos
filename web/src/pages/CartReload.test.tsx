import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDS, offerById, sampleCatalog, SAMPLE_TODAY } from "../__fixtures__";
import { addOffer, EMPTY_CART } from "../domain/cart";
import type { Offer } from "../domain/types";
import { renderWithCart } from "../test/cartHarness";
import { Cart } from "./Cart";

const base = sampleCatalog();
const NOW = new Date("2026-10-17T08:00:00Z");
const norm = (s: string | null) => (s ?? "").replace(/ /g, " ");

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${SAMPLE_TODAY}T09:00:00+03:00`));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("cart survives a reload", () => {
  it("quantities and the card toggle are read back from the same storage after a remount", async () => {
    const lidl = offerById(base, IDS.lidlPlus);
    const first = await renderWithCart(<Cart />, { cart: addOffer(EMPTY_CART, lidl, NOW, 1) });
    await userEvent.click(await screen.findByRole("button", { name: "Увеличи количеството" }));
    await userEvent.click(screen.getByRole("button", { name: "Увеличи количеството" }));
    await userEvent.click(screen.getByRole("checkbox"));
    const before = norm((await screen.findByTestId("subtotal-lidl")).textContent);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    first.unmount();

    await renderWithCart(<Cart />); // no preset: reads what the first mount wrote
    expect(norm((await screen.findByTestId("subtotal-lidl")).textContent)).toBe(before);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("Артикули: 3")).toBeInTheDocument();
  });

  it("a weight line shows the weight with the unit and the per kg price in the amounts", async () => {
    const kg: Offer = { ...offerById(base, IDS.billaPromo), sale_unit: "kg", unit_text: "За 1 кг" };
    await renderWithCart(<Cart />, { cart: addOffer(EMPTY_CART, kg, NOW, 1, 2000) });
    const out = await screen.findByRole("status");
    expect(norm(out.textContent)).toBe("2 кг");
    expect(norm((await screen.findByTestId("line-per-kg")).textContent)).toMatch(/\/кг$/);
  });

  it("weight stepper, presets and removal work and the grams survive a remount", async () => {
    const kg: Offer = { ...offerById(base, IDS.billaPromo), sale_unit: "kg", unit_text: "За 1 кг" };
    const first = await renderWithCart(<Cart />, { cart: addOffer(EMPTY_CART, kg, NOW) });
    await userEvent.click(await screen.findByRole("button", { name: "Увеличи теглото" }));
    expect(norm((await screen.findByRole("status")).textContent)).toBe("1,1 кг");
    await userEvent.click(screen.getByRole("button", { name: "0,25 кг" }));
    expect(norm((await screen.findByRole("status")).textContent)).toBe("0,25 кг");
    expect(screen.getByRole("button", { name: "0,25 кг" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "0,5 кг" }));
    first.unmount();
    await renderWithCart(<Cart />);
    expect(norm((await screen.findByRole("status")).textContent)).toBe("0,5 кг");
    await userEvent.click(screen.getByRole("button", { name: "Намали теглото" }));
    for (let i = 0; i < 4; i++) await userEvent.click(await screen.findByRole("button", { name: "Намали теглото" }));
    expect(await screen.findByText("Количката е празна")).toBeInTheDocument();
  });
});
