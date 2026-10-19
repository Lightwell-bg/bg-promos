import { describe, expect, it } from "vitest";
import { todaySofia } from "../../domain/dates";
import { bucketLabel, formatDelta, niceTicks, presetRange, rangeLabel, sourceLabel } from "./adminUtils";

describe("period presets (Europe/Sofia)", () => {
  // 22:30 UTC on 18 Oct is already 19 Oct 01:30 in Sofia (UTC+3): the browser/UTC date would be wrong.
  const today = todaySofia(new Date("2026-10-18T22:30:00Z"));

  it("uses the Sofia calendar day near midnight UTC", () => {
    expect(today).toBe("2026-10-19");
    expect(presetRange("today", today)).toEqual({ from: "2026-10-19", to: "2026-10-19" });
    expect(presetRange("yesterday", today)).toEqual({ from: "2026-10-18", to: "2026-10-18" });
    expect(presetRange("7", today)).toEqual({ from: "2026-10-13", to: "2026-10-19" });
    expect(presetRange("30", today)).toEqual({ from: "2026-09-20", to: "2026-10-19" });
    expect(presetRange("90", today)).toEqual({ from: "2026-07-22", to: "2026-10-19" });
    expect(presetRange("custom", today)).toBeNull();
  });
});

describe("formatDelta", () => {
  it("up, down, equal and new", () => {
    expect(formatDelta(15, 12)).toEqual({ kind: "up", text: "▲ 25% (было 12)" });
    expect(formatDelta(18, 20)).toEqual({ kind: "down", text: "▼ 10% (было 20)" });
    expect(formatDelta(5, 5)).toEqual({ kind: "equal", text: "= (было 5)" });
    expect(formatDelta(3, 0)).toEqual({ kind: "new", text: "▲ новое (было 0)" });
    expect(formatDelta(0, 0).kind).toBe("equal");
    expect(formatDelta(0, 4)).toEqual({ kind: "down", text: "▼ 100% (было 4)" });
  });
});

describe("labels and ticks", () => {
  it("bucket labels: hours and days", () => {
    expect(bucketLabel("2026-10-19T10:00:00+03:00", "hour")).toBe("10:00");
    expect(bucketLabel("2026-10-19T00:00:00+03:00", "day")).toBe("19.10");
    expect(rangeLabel("2026-10-12", "2026-10-18")).toBe("12.10–18.10");
    expect(rangeLabel("2026-10-12", "2026-10-12")).toBe("12.10");
  });

  it("unknown source label", () => {
    expect(sourceLabel("unknown", null, null)).toBe("Источник неизвестен");
    expect(sourceLabel("utm", "ig", "autumn")).toBe("utm / ig / autumn");
  });

  it("nice ticks start at 0 and cover the max", () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(2)).toEqual([0, 1, 2]);
    const t = niceTicks(37);
    expect(t[0]).toBe(0);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(37);
    expect(t.length).toBeLessThanOrEqual(6);
  });
});
