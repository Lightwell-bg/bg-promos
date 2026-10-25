/** Pure helpers of the admin dashboard: period presets (Europe/Sofia), deltas, labels, chart ticks. */

export const NO_SOURCE = "Источник неизвестен";

export type PresetId = "today" | "yesterday" | "7" | "30" | "90" | "custom";

export const PRESETS: { id: PresetId; label: string }[] = [
  { id: "today", label: "Сегодня" },
  { id: "yesterday", label: "Вчера" },
  { id: "7", label: "7 дней" },
  { id: "30", label: "30 дней" },
  { id: "90", label: "90 дней" },
  { id: "custom", label: "Период…" },
];

export const DEFAULT_PRESET: PresetId = "7";
export const PRESET_KEY = "bgp_admin_preset";

/** ISO date shifted by `days` (pure calendar arithmetic, no time zone involved). */
export function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** from/to of a preset; `today` is the Sofia date (see domain/dates.todaySofia). null for "custom". */
export function presetRange(id: PresetId, today: string): { from: string; to: string } | null {
  switch (id) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = shiftDate(today, -1);
      return { from: y, to: y };
    }
    case "7":
      return { from: shiftDate(today, -6), to: today };
    case "30":
      return { from: shiftDate(today, -29), to: today };
    case "90":
      return { from: shiftDate(today, -89), to: today };
    default:
      return null;
  }
}

export function loadPreset(): PresetId {
  try {
    const v = localStorage.getItem(PRESET_KEY);
    if (v === "today" || v === "yesterday" || v === "7" || v === "30" || v === "90") return v;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_PRESET;
}

export function savePreset(id: PresetId): void {
  if (id === "custom") return;
  try {
    localStorage.setItem(PRESET_KEY, id);
  } catch {
    /* storage unavailable */
  }
}

export type DeltaKind = "up" | "down" | "equal" | "new";

export interface Delta {
  kind: DeltaKind;
  text: string;
}

/** Change against the previous period: "▲ 25% (было 12)", "▼ 10% (было 20)", "= (было 5)", "▲ новое (было 0)". */
export function formatDelta(current: number, previous: number): Delta {
  const was = `(было ${previous})`;
  if (current === previous) return { kind: "equal", text: `= ${was}` };
  if (previous === 0) return { kind: "new", text: `▲ новое ${was}` };
  const pct = Math.round((Math.abs(current - previous) / previous) * 100);
  return current > previous
    ? { kind: "up", text: `▲ ${pct}% ${was}` }
    : { kind: "down", text: `▼ ${pct}% ${was}` };
}

/** "2026-10-12" -> "12.10". */
export function dayLabel(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
}

/** "12.10–18.10" (a single day: "12.10"). */
export function rangeLabel(from: string, to: string): string {
  return from === to ? dayLabel(from) : `${dayLabel(from)}–${dayLabel(to)}`;
}

/** Bucket start (ISO with the Sofia offset, already in local time) -> "10:00" or "19.10". */
export function bucketLabel(t: string, bucket: "hour" | "day"): string {
  return bucket === "hour" ? t.slice(11, 16) : dayLabel(t);
}

/** Axis ticks from 0 with a "nice" integer step; always at least [0, step]. */
export function niceTicks(max: number, target = 3): number[] {
  const top = Math.max(max, 1);
  const raw = top / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? pow * 10);
  const ticks: number[] = [];
  for (let v = 0; v < top + step; v += step) {
    ticks.push(v);
    if (v >= top) break;
  }
  return ticks;
}

export function platformLabel(p: string): string {
  return p === "web" ? "Сайт" : p === "miniapp" ? "Mini App" : p === "bot" ? "Бот" : p || "—";
}

export function sourceLabel(kind: string, source: string | null, campaign: string | null): string {
  if (kind === "unknown") return NO_SOURCE;
  const parts = [kind, source, campaign].filter((x): x is string => !!x);
  return parts.length ? parts.join(" / ") : NO_SOURCE;
}

/** Backend run timestamps may be naive (UTC without a zone mark): treat those as UTC, not browser-local. */
function parseUtc(iso: string): Date {
  const hasZone = /(Z|[+-]\d\d:?\d\d)$/i.test(iso);
  return new Date(hasZone || !iso.includes("T") ? iso : `${iso}Z`);
}

/** "25.10.2026, 14:05" in Europe/Sofia (never the browser zone). */
export function fmtSofia(iso: string | null): string {
  if (!iso) return "—";
  const d = parseUtc(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Sofia",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** "14:05" in Europe/Sofia. */
export function fmtHM(iso: string | null): string {
  if (!iso) return "—";
  const d = parseUtc(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Sofia", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

/** 65 -> "1 мин 5 с"; 12.4 -> "12 с". */
export function fmtDuration(s: number | null): string {
  if (s === null) return "—";
  const t = Math.round(s);
  return t < 60 ? `${t} с` : `${Math.floor(t / 60)} мин ${t % 60} с`;
}

export function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Sofia",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
