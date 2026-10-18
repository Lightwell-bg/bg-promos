import { errorName, type InsightName, type InsightProps } from "../domain/insightEvents";
import { clarityEvent } from "./clarity";
import { record as recordInsight, type RecordOptions } from "./insights";

export type AnalyticsParams = Record<string, string | number | boolean>;

export interface Analytics {
  track(event: string, params?: AnalyticsParams): void;
}

/** Default: no-op. GA4 (with consent) is plugged in via setAnalytics. */
export const noopAnalytics: Analytics = {
  track() {
    /* no-op */
  },
};

let current: Analytics = noopAnalytics;

export function setAnalytics(a: Analytics): void {
  current = a;
}

/** Google Analytics 4 events (whitelisted in platform/ga.ts). Everything is a no-op without consent. */
export function track(event: string, params?: AnalyticsParams): void {
  try {
    current.track(event, params);
  } catch {
    /* analytics must never break the app */
  }
}

/** Internal events that are also sent to Clarity (by name only). */
const CLARITY_EVENTS = new Set<string>(["catalog_loaded", "cart_add", "share_link_created", "cart_import"]);

/**
 * One logical action of the user -> internal analytics (docs/ANALYTICS.md) and, for a few events,
 * a Clarity event. Returns true when the event was queued. No consent / disabled -> false, nothing is sent.
 */
export function record(name: InsightName, props: InsightProps = {}, opts: RecordOptions = {}): boolean {
  try {
    const ok = recordInsight(name, props, opts);
    if (ok && CLARITY_EVENTS.has(name)) clarityEvent(name);
    return ok;
  } catch {
    return false;
  }
}

/** Error report: class name and a short "where" only; never the message or the stack. */
export function reportAppError(error: unknown, where: string): void {
  record("app_error", { name: errorName(error), where: where.slice(0, 60) });
}

let handlersInstalled = false;

/** window 'error' and 'unhandledrejection' -> app_error (installed once, harmless without consent). */
export function installGlobalErrorHandlers(): void {
  if (handlersInstalled || typeof window === "undefined") return;
  handlersInstalled = true;
  window.addEventListener("error", (e) => reportAppError(e.error, "window"));
  window.addEventListener("unhandledrejection", (e) => reportAppError(e.reason, "promise"));
}
