import { describe, expect, it } from "vitest";
import { IDS, offerById, sampleCatalog, SAMPLE_TODAY } from "../__fixtures__";
import { daysLeft, formatDayMonth, formatSofiaDateTime, status, todaySofia, validityLabel } from "./dates";

const cat = sampleCatalog();
const o = (id: string) => offerById(cat, id);

describe("todaySofia", () => {
  it("rolls over to the next day after 21:00Z while EEST (UTC+3)", () => {
    expect(todaySofia(new Date("2026-10-18T21:30:00Z"))).toBe("2026-10-19");
    expect(todaySofia(new Date("2026-10-18T20:30:00Z"))).toBe("2026-10-18");
  });
  it("uses UTC+2 in winter", () => {
    expect(todaySofia(new Date("2026-12-31T22:30:00Z"))).toBe("2027-01-01");
    expect(todaySofia(new Date("2026-12-31T21:30:00Z"))).toBe("2026-12-31");
  });
});

describe("status", () => {
  it("classifies active / upcoming / ended", () => {
    expect(status(o(IDS.lidlPromo), SAMPLE_TODAY)).toBe("active");
    expect(status(o(IDS.upcoming), SAMPLE_TODAY)).toBe("upcoming");
    expect(status(o(IDS.ended), SAMPLE_TODAY)).toBe("ended");
  });
  it("valid_to is inclusive; the day after it is ended", () => {
    expect(status(o(IDS.endingToday), "2026-10-17")).toBe("active");
    expect(status(o(IDS.endingToday), "2026-10-18")).toBe("ended");
  });
  it("open-ended offers stay active", () => {
    expect(status(o(IDS.regularOnly), "2030-01-01")).toBe("active");
  });
});

describe("daysLeft", () => {
  it("is 0 on the last day, null when open-ended", () => {
    expect(daysLeft(o(IDS.endingToday), SAMPLE_TODAY)).toBe(0);
    expect(daysLeft(o(IDS.lidlPlus), SAMPLE_TODAY)).toBe(1);
    expect(daysLeft(o(IDS.regularOnly), SAMPLE_TODAY)).toBeNull();
  });
  it("works across month boundaries", () => {
    expect(daysLeft({ valid_to: "2026-11-02" }, "2026-10-30")).toBe(3);
  });
});

describe("validityLabel", () => {
  it("formats 'until', 'from', last day", () => {
    expect(validityLabel(o(IDS.lidlPromo), SAMPLE_TODAY)).toEqual({ key: "validity.until", params: { date: "21.10" } });
    expect(validityLabel(o(IDS.endingToday), SAMPLE_TODAY).key).toBe("validity.lastDay");
    expect(validityLabel(o(IDS.upcoming), SAMPLE_TODAY)).toEqual({
      key: "validity.range",
      params: { from: "19.10", to: "25.10" },
    });
    expect(validityLabel({ valid_from: "2026-10-19", valid_to: null }, SAMPLE_TODAY)).toEqual({
      key: "validity.from",
      params: { date: "19.10" },
    });
    expect(validityLabel(o(IDS.regularOnly), SAMPLE_TODAY).key).toBe("validity.none");
  });
  it("formatDayMonth", () => {
    expect(formatDayMonth("2026-10-21")).toBe("21.10");
  });
});

describe("formatSofiaDateTime", () => {
  it("renders Sofia local time", () => {
    expect(formatSofiaDateTime("2026-10-17T12:55:59+00:00")).toBe("17.10, 15:55");
  });
});
