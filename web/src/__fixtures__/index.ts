import type { Catalog, Offer } from "../domain/types";
import raw from "./catalog.sample.json";

/** Sample catalog matching docs/API.md; "today" in the sample is 2026-10-17. */
export function sampleCatalog(): Catalog {
  return structuredClone(raw) as unknown as Catalog;
}

export const SAMPLE_TODAY = "2026-10-17";

export function offerById(catalog: Catalog, id: string): Offer {
  const o = catalog.offers.find((x) => x.id === id);
  if (!o) throw new Error(`fixture offer ${id} not found`);
  return o;
}

/** Handy ids from the sample catalog. */
export const IDS = {
  lidlPromo: "a1b2c3d4e5f1",
  lidlPlus: "a1b2c3d4e5f2",
  kauflandOnePlusOne: "a1b2c3d4e5f3",
  kauflandMultibuy: "a1b2c3d4e5f4",
  kauflandBrandCard: "a1b2c3d4e5f5",
  billaPromo: "a1b2c3d4e5f6",
  billaCard: "a1b2c3d4e5f7",
  upcoming: "a1b2c3d4e5f8",
  endingToday: "a1b2c3d4e5f9",
  regularOnly: "a1b2c3d4e5fa",
  cardNoRegular: "a1b2c3d4e5fb",
  computedUnit: "a1b2c3d4e5fc",
  ended: "a1b2c3d4e5fd",
} as const;
