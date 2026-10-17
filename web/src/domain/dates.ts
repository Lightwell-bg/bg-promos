import type { Offer } from "./types";

const sofiaFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Sofia",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Current calendar date in Europe/Sofia as YYYY-MM-DD. */
export function todaySofia(now: Date = new Date()): string {
  const parts = sofiaFmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export type OfferStatus = "active" | "upcoming" | "ended";

export function status(offer: Pick<Offer, "valid_from" | "valid_to">, today: string): OfferStatus {
  if (offer.valid_to && offer.valid_to < today) return "ended";
  if (offer.valid_from && offer.valid_from > today) return "upcoming";
  return "active";
}

function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function diffDays(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/** Days left including nothing after valid_to: 0 = last day. Null when open-ended. */
export function daysLeft(offer: Pick<Offer, "valid_to">, today: string): number | null {
  if (!offer.valid_to) return null;
  return diffDays(today, offer.valid_to);
}

/** "2026-10-21" -> "21.10" */
export function formatDayMonth(date: string): string {
  const [, m, d] = date.split("-");
  return `${d}.${m}`;
}

export interface ValidityLabel {
  /** i18n key */
  key: "validity.until" | "validity.from" | "validity.lastDay" | "validity.range" | "validity.none";
  params: Record<string, string>;
}

/** Describes validity in terms of i18n keys: "до 21.10" / "от 19.10" / last day. */
export function validityLabel(
  offer: Pick<Offer, "valid_from" | "valid_to">,
  today: string,
): ValidityLabel {
  const st = status(offer, today);
  if (st === "upcoming" && offer.valid_from) {
    if (offer.valid_to) {
      return {
        key: "validity.range",
        params: { from: formatDayMonth(offer.valid_from), to: formatDayMonth(offer.valid_to) },
      };
    }
    return { key: "validity.from", params: { date: formatDayMonth(offer.valid_from) } };
  }
  if (offer.valid_to) {
    if (offer.valid_to === today) return { key: "validity.lastDay", params: {} };
    return { key: "validity.until", params: { date: formatDayMonth(offer.valid_to) } };
  }
  return { key: "validity.none", params: {} };
}

/** "17.10, 15:55" in Sofia time for an ISO timestamp. */
export function formatSofiaDateTime(iso: string | number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Sofia",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("day")}.${g("month")}, ${g("hour")}:${g("minute")}`;
}
