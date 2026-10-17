import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IDS, offerById, sampleCatalog } from "../__fixtures__";
import type { Lang, Offer, PriceCondition, SaleUnit } from "../domain/types";
import { LangProvider } from "../i18n/LangContext";
import { PriceBlock } from "./PriceBlock";

const cat = sampleCatalog();

function cond(kind: PriceCondition["kind"], program: PriceCondition["program"], total: number): PriceCondition {
  return { kind, program, min_qty: 1, total_cents: total, per_item_cents: total, discount_pct: null, text: null };
}

/** BILLA "Деликатес Житница Пушено свинско филе ... За 1 кг": card price, price without card, regular. */
function smokedFillet(saleUnit: SaleUnit | undefined): Offer {
  const o = structuredClone(offerById(cat, IDS.billaCard)) as Offer;
  const regular = cond("regular", null, 2227);
  const card = cond("loyalty", "billa_card", 1400);
  const promo = cond("promo", null, 1533);
  o.name = "Деликатес Житница Пушено свинско филе";
  o.unit_text = "За 1 кг";
  o.prices = [regular, card, promo];
  o.best = card;
  o.no_card = promo;
  o.regular_cents = 2227;
  o.savings_per_item_cents = 694;
  o.unit_price = null;
  if (saleUnit === undefined) delete (o as unknown as Record<string, unknown>).sale_unit;
  else o.sale_unit = saleUnit;
  return o;
}

const text = (el: HTMLElement) => (el.textContent ?? "").replace(/ /g, " ");

function renderBlock(offer: Offer, lang: Lang) {
  return render(
    <LangProvider lang={lang}>
      <PriceBlock offer={offer} variant="full" />
    </LangProvider>,
  );
}

describe("PriceBlock sale unit", () => {
  it("a per-kg offer shows the price without card and the saving per kg (bg)", () => {
    const t = text(renderBlock(smokedFillet("kg"), "bg").container);
    expect(t).toContain("Без карта: 15,33 €/кг");
    expect(t).toContain("Спестявате 6,94 €/кг");
    expect(t).not.toContain("/бр.");
  });

  it("a per-kg offer in Russian", () => {
    const t = text(renderBlock(smokedFillet("kg"), "ru").container);
    expect(t).toContain("Без карты: 15,33 €/кг");
    expect(t).toContain("Вы экономите 6,94 €/кг");
  });

  it("a per-litre offer uses /л", () => {
    const t = text(renderBlock(smokedFillet("l"), "bg").container);
    expect(t).toContain("Без карта: 15,33 €/л");
  });

  it("a piece offer keeps /бр. (bg) and /шт. (ru)", () => {
    expect(text(renderBlock(smokedFillet("piece"), "bg").container)).toContain("Без карта: 15,33 €/бр.");
    expect(text(renderBlock(smokedFillet("piece"), "ru").container)).toContain("Вы экономите 6,94 €/шт.");
  });

  it("a cached catalog without sale_unit is treated as pieces", () => {
    expect(text(renderBlock(smokedFillet(undefined), "bg").container)).toContain("Без карта: 15,33 €/бр.");
  });
});
