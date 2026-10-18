import { errorProps, type ErrorInfoInput, type InsightName, type InsightProps } from "../domain/insightEvents";
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

const ERROR_PER_SIGNATURE = 5;
const ERROR_TOTAL = 20;
let errorTotal = 0;
const errorSignatures = new Map<string, number>();

/** Test helper: forget the per page-load anti-flood counters. */
export function resetErrorCountersForTests(): void {
  errorTotal = 0;
  errorSignatures.clear();
}

/**
 * Error report -> INTERNAL analytics only (name, message, file, line, stack, page path): the owner
 * wants the details to fix bugs. Never passed to Clarity or GA4. Anti-flood: at most 5 per
 * signature (name + message + file + line) and 20 in total per page load.
 */
export function reportError(input: ErrorInfoInput): void {
  try {
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    const pathname = typeof window === "undefined" ? "" : window.location.pathname;
    const props = errorProps(input, origin, pathname);
    const sig = `${props.name}|${props.message}|${props.file}|${props.line ?? ""}`;
    const n = errorSignatures.get(sig) ?? 0;
    if (n >= ERROR_PER_SIGNATURE || errorTotal >= ERROR_TOTAL) return;
    if (record("app_error", props)) {
      errorSignatures.set(sig, n + 1);
      errorTotal++;
    }
  } catch {
    /* error reporting must never throw */
  }
}

/** Error caught somewhere in the app (ErrorBoundary and similar). */
export function reportAppError(error: unknown, where: string, componentStack?: string): void {
  reportError({ where, error, componentStack });
}

let handlersInstalled = false;

/** window 'error' and 'unhandledrejection' -> app_error (installed once, harmless without consent). */
export function installGlobalErrorHandlers(): void {
  if (handlersInstalled || typeof window === "undefined") return;
  handlersInstalled = true;
  window.addEventListener("error", (e) =>
    reportError({
      where: "window",
      error: e.error ?? undefined,
      message: e.message,
      filename: e.filename,
      line: e.lineno,
      col: e.colno,
    }),
  );
  window.addEventListener("unhandledrejection", (e) =>
    reportError({ where: "promise", error: e.reason, rejection: true }),
  );
}
