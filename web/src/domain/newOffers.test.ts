import { describe, expect, it } from "vitest";
import { chainFirstSeen, isNewOffer, newOffers } from "./newOffers";
import type { ChainId, Offer } from "./types";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const H = 3_600_000;

function offer(id: string, chain: ChainId, hoursAgo: number): Offer {
  return { id, chain, first_seen_at: new Date(NOW - hoursAgo * H).toISOString() } as Offer;
}

describe("newOffers", () => {
  const all = [
    offer("old-import", "lidl", 24 * 30), // chain's initial import, long ago
    offer("lidl-old", "lidl", 24 * 30),
    offer("lidl-new", "lidl", 10),
    offer("lidl-4d", "lidl", 24 * 4),
    offer("kauf-import", "kaufland", 20), // initial import within 3 days
    offer("kauf-import2", "kaufland", 19),
    offer("kauf-new", "kaufland", 2), // 18 h after earliest: still initial import window
  ];

  it("computes the earliest first_seen_at per chain", () => {
    const m = chainFirstSeen(all);
    expect(m.get("lidl")).toBe(NOW - 24 * 30 * H);
    expect(m.get("kaufland")).toBe(NOW - 20 * H);
    expect(m.has("billa")).toBe(false);
  });

  it("excludes a chain's initial import and offers older than 3 days", () => {
    const ids = newOffers(all, all, NOW).map((o) => o.id);
    expect(ids).toEqual(["lidl-new"]);
  });

  it("requires strictly more than 24 h after the chain's earliest", () => {
    const base = offer("a", "billa", 48);
    const edge = offer("b", "billa", 24); // exactly 24 h after
    const later = offer("c", "billa", 23.9);
    const earliest = chainFirstSeen([base, edge, later]);
    expect(isNewOffer(edge, earliest, NOW)).toBe(false);
    expect(isNewOffer(later, earliest, NOW)).toBe(true);
  });

  it("sorts newest first and ignores invalid dates", () => {
    const list = [offer("x", "lidl", 100), offer("y", "lidl", 30), offer("z", "lidl", 5), offer("bad", "lidl", 1)];
    list[3].first_seen_at = "nope";
    expect(newOffers(list, list, NOW).map((o) => o.id)).toEqual(["z", "y"]);
  });
});
