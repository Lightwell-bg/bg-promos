import type { ChainId, Offer } from "./types";

export const NEW_DAYS = 3;
const DAY_MS = 86_400_000;

/** Earliest first_seen_at (ms) per chain over the given offers. */
export function chainFirstSeen(offers: readonly Offer[]): Map<ChainId, number> {
  const map = new Map<ChainId, number>();
  for (const o of offers) {
    const ts = Date.parse(o.first_seen_at);
    if (Number.isNaN(ts)) continue;
    const prev = map.get(o.chain);
    if (prev === undefined || ts < prev) map.set(o.chain, ts);
  }
  return map;
}

/**
 * "New" = first seen within the last NEW_DAYS days AND more than 24 h after the
 * chain's earliest first_seen_at (so a chain's initial import is not "new").
 */
export function isNewOffer(
  offer: Pick<Offer, "chain" | "first_seen_at">,
  earliest: ReadonlyMap<ChainId, number>,
  nowMs: number,
): boolean {
  const ts = Date.parse(offer.first_seen_at);
  if (Number.isNaN(ts)) return false;
  if (ts < nowMs - NEW_DAYS * DAY_MS) return false;
  const first = earliest.get(offer.chain);
  if (first === undefined) return false;
  return ts - first > DAY_MS;
}

/** New offers, newest first. */
export function newOffers(offers: readonly Offer[], all: readonly Offer[], nowMs: number): Offer[] {
  const earliest = chainFirstSeen(all);
  return offers
    .filter((o) => isNewOffer(o, earliest, nowMs))
    .sort((a, b) => Date.parse(b.first_seen_at) - Date.parse(a.first_seen_at));
}
