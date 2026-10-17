import type { Analytics, AnalyticsParams } from "./analytics";

/**
 * Google Analytics 4 with Consent Mode v2.
 * Nothing from Google is requested until `enable()` is called (i.e. after the
 * user accepted). Search text and other personal data are never sent: only
 * whitelisted events and parameters below are forwarded.
 */

/** App event -> GA event name and the parameters that may be forwarded (renamed). */
export const EVENT_MAP: Record<string, { name: string; params: Record<string, string> }> = {
  search: { name: "search", params: { len: "query_length", results: "results_count" } },
  filter_apply: { name: "filter_apply", params: { count: "filters_count" } },
  sort_change: { name: "sort_change", params: { sort: "sort" } },
  view_offer: { name: "view_offer", params: { chain: "chain", category: "category" } },
  outbound_source_click: { name: "outbound_source_click", params: { chain: "chain", product: "is_product" } },
  source_click: { name: "outbound_source_click", params: { chain: "chain", product: "is_product" } },
  brochure_click: { name: "brochure_click", params: { chain: "chain" } },
  share: { name: "share", params: { chain: "chain" } },
  lang_switch: { name: "lang_switch", params: { lang: "lang" } },
  install_prompt_shown: { name: "install_prompt_shown", params: { platform: "platform" } },
  install_prompt_accepted: { name: "install_prompt_accepted", params: {} },
  report_submitted: { name: "report_submitted", params: {} },
  offline_view: { name: "offline_view", params: {} },
};

/** Constant title reported to GA instead of the real document.title. */
const PAGE_TITLE = "BG Promos";

const SAFE_STRING = /^[A-Za-z0-9_.-]{1,40}$/;

/** Maps an app event to a GA event; null when the event is not allowed. */
export function mapEvent(
  event: string,
  params?: AnalyticsParams,
): { name: string; params: Record<string, string | number | boolean> } | null {
  const def = Object.prototype.hasOwnProperty.call(EVENT_MAP, event) ? EVENT_MAP[event] : undefined;
  if (!def) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [from, to] of Object.entries(def.params)) {
    const v = params?.[from];
    if (typeof v === "number" && Number.isFinite(v)) out[to] = v;
    else if (typeof v === "boolean") out[to] = v;
    else if (typeof v === "string" && SAFE_STRING.test(v)) out[to] = v;
  }
  return { name: def.name, params: out };
}

type Gtag = (...args: unknown[]) => void;
interface GaWindow {
  dataLayer?: unknown[];
  gtag?: Gtag;
  [key: string]: unknown;
}

/** Deletes _ga / _ga_* cookies on the host and its parent domains. */
export function deleteGaCookies(doc: Document = document, hostname: string = location.hostname): void {
  const names = doc.cookie
    .split(";")
    .map((c) => c.split("=")[0].trim())
    .filter((n) => n === "_ga" || n.startsWith("_ga_") || n === "_gid" || n.startsWith("_gat"));
  const parts = hostname.split(".");
  const domains: (string | null)[] = [null, hostname];
  for (let i = 1; i < parts.length - 1; i++) domains.push("." + parts.slice(i).join("."));
  for (const name of names) {
    for (const d of domains) {
      doc.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${d ? `; domain=${d}` : ""}`;
    }
  }
}

export interface GoogleAnalytics extends Analytics {
  readonly id: string;
  /** Loads gtag.js (once) and grants analytics_storage. Call only after consent. */
  enable(): void;
  /** Stops tracking, denies storage and deletes _ga cookies. */
  disable(): void;
  isEnabled(): boolean;
  pageView(path: string, lang?: string): void;
}

export function createGoogleAnalytics(
  measurementId: string,
  win: Window = window,
  doc: Document = document,
): GoogleAnalytics {
  const w = win as unknown as GaWindow;
  let loaded = false;
  let enabled = false;

  // gtag.js expects the `arguments` object itself (not an array) in the dataLayer.
  function gtag(..._args: unknown[]): void {
    (w.dataLayer as unknown[]).push(arguments);
  }

  function load(): void {
    w.dataLayer = w.dataLayer || [];
    w.gtag = gtag;
    gtag("consent", "default", {
      analytics_storage: "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
    gtag("js", new Date());
    gtag("consent", "update", { analytics_storage: "granted" });
    gtag("config", measurementId, {
      send_page_view: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      anonymize_ip: true,
    });
    const s = doc.createElement("script");
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
    doc.head.appendChild(s);
    loaded = true;
  }

  /**
   * Privacy: GA would otherwise read location.href (query string, hash), document.title
   * (the product name on offer pages) and document.referrer by itself. Override them with
   * a sanitized page identity before every hit.
   */
  function pageIdentity(path?: string): Record<string, string> {
    const clean = path !== undefined ? path.split(/[?#]/)[0] : win.location.pathname;
    return { page_location: `${win.location.origin}${clean}`, page_title: PAGE_TITLE, page_referrer: "" };
  }
  function setPage(path?: string): void {
    gtag("set", pageIdentity(path));
  }

  return {
    id: measurementId,
    enable() {
      if (enabled) return;
      w[`ga-disable-${measurementId}`] = false;
      if (!loaded) load();
      else gtag("consent", "update", { analytics_storage: "granted" });
      setPage();
      enabled = true;
    },
    disable() {
      const wasEnabled = enabled;
      enabled = false;
      w[`ga-disable-${measurementId}`] = true;
      if (loaded && wasEnabled) gtag("consent", "update", { analytics_storage: "denied" });
      try {
        deleteGaCookies(doc, win.location.hostname);
      } catch {
        /* ignore */
      }
    },
    isEnabled: () => enabled,
    track(event, params) {
      if (!enabled) return;
      const mapped = mapEvent(event, params);
      if (!mapped) return;
      setPage();
      gtag("event", mapped.name, { ...mapped.params, ...pageIdentity() });
    },
    pageView(path, lang) {
      if (!enabled) return;
      // Path only: the query string may hold the search text.
      const clean = path.split(/[?#]/)[0];
      setPage(clean);
      gtag("event", "page_view", {
        page_path: clean,
        ...pageIdentity(clean),
        ...(lang ? { language: lang } : {}),
      });
    },
  };
}
