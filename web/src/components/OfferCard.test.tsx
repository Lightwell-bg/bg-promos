import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { IDS, offerById, sampleCatalog, SAMPLE_TODAY } from "../__fixtures__";
import type { Lang } from "../domain/types";
import { LangProvider } from "../i18n/LangContext";
import { OfferCard } from "./OfferCard";

const cat = sampleCatalog();

function renderCard(id: string, lang: Lang = "bg") {
  const offer = offerById(cat, id);
  return render(
    <MemoryRouter>
      <LangProvider lang={lang}>
        <OfferCard
          offer={offer}
          category={cat.categories.find((c) => c.id === offer.category)}
          today={SAMPLE_TODAY}
        />
      </LangProvider>
    </MemoryRouter>,
  );
}

const text = (el: HTMLElement) => (el.textContent ?? "").replace(/ /g, " ");

describe("OfferCard", () => {
  it("multibuy shows the total with quantity, the per-item line and a condition chip", () => {
    const { container } = renderCard(IDS.kauflandMultibuy);
    const t = text(container);
    expect(t).toContain("3,98 € за 2 бр.");
    expect(t).toContain("1,99 €/бр. при покупка на 2");
    expect(screen.getByText("При покупка на 2 бр.")).toBeInTheDocument();
    expect(t).toContain("-20%");
    expect(t).toContain("4,98 €"); // struck regular x qty
  });

  it("loyalty offer shows the program chip and the price without card", () => {
    const { container } = renderCard(IDS.lidlPlus);
    expect(screen.getByText("С Lidl Plus")).toBeInTheDocument();
    expect(text(container)).toContain("Без карта: 1,59 €");
    expect(container.querySelector('[title="изчислено от грамажа"]')?.textContent).toContain("≈");
  });

  it("best multibuy with a program: the regular no-card line keeps its per-item basis", () => {
    const { container } = renderCard(IDS.kauflandOnePlusOne);
    const t = text(container);
    expect(t).toContain("Без карта: 1,99 €/бр.");
    expect(t).toContain("1,99 € за 2 бр.");
  });

  it("no-card multibuy shows total, quantity and per-item price", () => {
    const offer = structuredClone(offerById(cat, IDS.lidlPlus));
    offer.no_card = { kind: "multibuy", program: null, min_qty: 2, total_cents: 378, per_item_cents: 189, discount_pct: null, text: null };
    const { container } = render(
      <MemoryRouter>
        <LangProvider lang="ru">
          <OfferCard offer={offer} today={SAMPLE_TODAY} />
        </LangProvider>
      </MemoryRouter>,
    );
    expect(text(container)).toContain("Без карты: 3,78 € за 2 шт. (1,89 €/шт.)");
  });

  it("card price with no 'without card' data says so", () => {
    const { container } = renderCard(IDS.cardNoRegular);
    expect(text(container)).toContain("Цена без карта: няма данни");
  });

  it("renders in Russian", () => {
    const { container } = renderCard(IDS.kauflandMultibuy, "ru");
    expect(text(container)).toContain("3,98 € за 2 шт.");
    expect(screen.getByText("При покупке 2 шт.")).toBeInTheDocument();
  });

  it("falls back to a category emoji placeholder when there is no image", () => {
    renderCard(IDS.billaPromo);
    expect(screen.queryByRole("img", { hidden: false })?.textContent).toContain("🥩");
  });

  it("uses a lazy, no-referrer image when present", () => {
    const { container } = renderCard(IDS.lidlPromo);
    const img = container.querySelector("img");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("referrerpolicy", "no-referrer");
  });

  it("marks the last day", () => {
    renderCard(IDS.endingToday);
    expect(screen.getByText("последен ден")).toBeInTheDocument();
  });
});
