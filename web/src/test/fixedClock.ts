import { vi } from "vitest";

/** A moment inside the validity of the offers in `__fixtures__/catalog.sample.json`. */
export const FIXTURE_NOW = "2026-10-17T10:00:00+03:00";

/** Pins only `Date` (timers stay real, so waitFor/userEvent keep working) so fixture offers never "end". */
export function pinClock(at: string = FIXTURE_NOW): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
}

export function unpinClock(): void {
  vi.useRealTimers();
}
