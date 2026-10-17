export type AnalyticsParams = Record<string, string | number | boolean>;

export interface Analytics {
  track(event: string, params?: AnalyticsParams): void;
}

/** Default: no-op. GA4 (with consent) is plugged in later via setAnalytics. */
export const noopAnalytics: Analytics = {
  track() {
    /* no-op */
  },
};

let current: Analytics = noopAnalytics;

export function setAnalytics(a: Analytics): void {
  current = a;
}

export function track(event: string, params?: AnalyticsParams): void {
  try {
    current.track(event, params);
  } catch {
    /* analytics must never break the app */
  }
}
