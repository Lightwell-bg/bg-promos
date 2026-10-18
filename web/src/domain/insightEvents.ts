/**
 * Pure helpers for the internal analytics (docs/ANALYTICS.md): launch parameters, sanitising,
 * event property builders. No DOM access, no network.
 */

/** Names of events the client may send (the server rejects anything else). */
export const INSIGHT_EVENTS = [
  "catalog_loaded",
  "offer_view",
  "search",
  "filter_apply",
  "cart_add",
  "cart_remove",
  "cart_qty",
  "card_toggle",
  "share_link_created",
  "share_copy",
  "cart_import",
  "app_error",
] as const;
export type InsightName = (typeof INSIGHT_EVENTS)[number];
export type InsightProps = Record<string, string | number | boolean | string[]>;

/** The only UTM keys that are ever read from the landing URL. */
export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content"] as const;
export type UtmKey = (typeof UTM_KEYS)[number];

const UTM_CLEAN = /[^a-z0-9._-]/g;

/** UTM value: lower case, only [a-z0-9._-], at most 64 chars; null when nothing is left. */
export function sanitizeUtmValue(v: string): string | null {
  const clean = v.trim().toLowerCase().replace(UTM_CLEAN, "").slice(0, 64);
  return clean || null;
}

/** Only the 4 UTM keys of a query string, sanitised; other parameters are ignored. */
export function parseUtm(search: string): Partial<Record<UtmKey, string>> {
  const out: Partial<Record<UtmKey, string>> = {};
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.replace(/^\?/, ""));
  } catch {
    return out;
  }
  for (const key of UTM_KEYS) {
    const raw = params.get(key);
    const clean = raw === null ? null : sanitizeUtmValue(raw);
    if (clean) out[key] = clean;
  }
  return out;
}

/** Referrer reduced to its origin (no path, no query); null for our own site or garbage. */
export function referrerOrigin(referrer: string, ownHost: string): string | null {
  if (!referrer) return null;
  try {
    const u = new URL(referrer);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.hostname === ownHost) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Raw Telegram initData from the launch hash (`#tgWebAppData=<urlencoded>`), URL-decoded once.
 * It is only forwarded to our server, which verifies the HMAC; the client never reads ids from it.
 */
export function parseInitData(hash: string): string | null {
  const v = new URLSearchParams(hash.replace(/^#/, "")).get("tgWebAppData");
  return v && v.length <= 4096 ? v : null;
}

function startParamFrom(raw: string): string | null {
  const v = new URLSearchParams(raw.replace(/^[?#]/, "")).get("tgWebAppStartParam");
  return v || null;
}

/** Telegram start parameter (query first, then hash), or null. */
export function parseStartParam(search: string, hash: string): string | null {
  return startParamFrom(search) ?? startParamFrom(hash);
}

const LABEL_RE = /^s_[a-z0-9]{1,32}(?:-[a-z0-9_]{1,40})?$/;

/**
 * Only the source label of a start parameter (`s_<campaign>[-<placement>]`); a shared cart
 * (`__c1_…` or a bare `c1_…`) is never sent as analytics.
 */
export function startLabel(param: string | null): string | null {
  if (!param) return null;
  const label = param.split("__")[0].trim().toLowerCase();
  return LABEL_RE.test(label) ? label : null;
}

export interface LandingSource {
  kind: "utm" | "startapp" | "referrer" | "unknown";
  campaign: string | null;
}

/** Best guess of the source from the landing data (used for Clarity tags before the server answers). */
export function landingSource(
  utm: Partial<Record<UtmKey, string>>,
  label: string | null,
  referrer: string | null,
): LandingSource {
  if (utm.utm_source || utm.utm_campaign) return { kind: "utm", campaign: utm.utm_campaign ?? null };
  if (label) {
    const m = /^s_([a-z0-9]+)/.exec(label);
    return { kind: "startapp", campaign: m ? m[1] : null };
  }
  if (referrer) return { kind: "referrer", campaign: null };
  return { kind: "unknown", campaign: null };
}

/** Search text for the zero-result report: trimmed, lower case, single spaces, at most 60 chars. */
export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 60);
}

/** `search` props: the query text goes in ONLY when nothing was found. */
export function searchProps(query: string, results: number): InsightProps {
  const q = query.trim();
  const props: InsightProps = { len: q.length, results };
  if (results === 0) {
    const norm = normalizeQuery(q);
    if (norm) props.query = norm;
  }
  return props;
}

/** Names of the filters that differ between two filter objects (values are never reported). */
export function changedKeys<T extends object>(prev: T, next: T): string[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const out: string[] = [];
  for (const k of keys) {
    const a = (prev as Record<string, unknown>)[k];
    const b = (next as Record<string, unknown>)[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(k);
  }
  return out.sort();
}

const ERR_NAME = /^[A-Za-z0-9_.$ -]{1,60}$/;

/** Error class name; "Error" for anything unusual. */
export function errorName(e: unknown): string {
  const n = (e as { name?: unknown } | null)?.name;
  return typeof n === "string" && ERR_NAME.test(n) ? n : "Error";
}

export type ErrorSource = "own" | "external" | "unknown";

/** Raw facts about an error; `errorProps` turns them into the app_error props. */
export interface ErrorInfoInput {
  where: string;
  /** The thrown value (Error, string, object, undefined). */
  error?: unknown;
  /** window 'error' fallbacks when there is no error object. */
  message?: string;
  filename?: string;
  line?: number;
  col?: number;
  /** React componentStack (ErrorBoundary). */
  componentStack?: string;
  /** The reason of an unhandledrejection (non-Error values become name "Rejection"). */
  rejection?: boolean;
}

export const ERROR_LIMITS = { name: 60, where: 60, message: 300, file: 160, stack: 1500, path: 160 } as const;

const clip = (v: string, n: number): string => v.slice(0, n);
const URL_IN_TEXT = /https?:\/\/[^\s)'"<>]+/;

/** Script URL without query/hash: own origin -> path only, other origin -> host + path. */
export function fileOf(url: string, ownOrigin: string): { source: ErrorSource; file: string } {
  if (!url) return { source: "unknown", file: "" };
  try {
    const u = new URL(url, ownOrigin || undefined);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { source: "unknown", file: clip(u.protocol, 160) };
    if (ownOrigin && u.origin === ownOrigin) return { source: "own", file: clip(u.pathname, ERROR_LIMITS.file) };
    return { source: "external", file: clip(u.host + u.pathname, ERROR_LIMITS.file) };
  } catch {
    return { source: "unknown", file: "" };
  }
}

function describe(value: unknown): { name: string; message: string; stack: string } {
  if (value instanceof Error || (value && typeof value === "object" && "message" in value)) {
    const v = value as { message?: unknown; stack?: unknown };
    return {
      name: errorName(value),
      message: typeof v.message === "string" ? v.message : "",
      stack: typeof v.stack === "string" ? v.stack : "",
    };
  }
  if (value === undefined || value === null) return { name: "Error", message: "", stack: "" };
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return { name: "Error", message: text, stack: "" };
}

/**
 * app_error props: technical description of an error for fixing bugs (INTERNAL analytics only,
 * never forwarded to Clarity / GA4). Strings are clipped, URLs have no query/hash, `path` is the
 * page path without query and hash (the hash holds the shared cart).
 */
export function errorProps(input: ErrorInfoInput, ownOrigin: string, pathname: string): InsightProps {
  let { name, message, stack } = describe(input.error);
  const hasError = input.error !== undefined && input.error !== null;
  if (input.rejection && !(input.error instanceof Error)) name = "Rejection";
  if (!hasError && !input.rejection) message = input.message ?? "";
  if (!hasError && /^Script error/i.test(message)) name = "ScriptError";
  else if (/ResizeObserver loop/i.test(message)) name = "ResizeObserver";

  let file = "";
  let source: ErrorSource = "unknown";
  let line: number | null = Number.isInteger(input.line) && (input.line as number) >= 0 ? (input.line as number) : null;
  let col: number | null = Number.isInteger(input.col) && (input.col as number) >= 0 ? (input.col as number) : null;
  if (input.filename) {
    ({ source, file } = fileOf(input.filename, ownOrigin));
  } else {
    // First URL of the stack ("at f (https://host/assets/x.js:10:5)" or "f@https://…:10:5").
    const m = URL_IN_TEXT.exec(stack);
    if (m) {
      const pos = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(m[0]);
      ({ source, file } = fileOf(pos?.[1] ?? m[0], ownOrigin));
      if (line === null && pos?.[2]) line = Number(pos[2]);
      if (col === null && pos?.[3]) col = Number(pos[3]);
    }
  }
  if (name === "ScriptError") source = "external";

  let fullStack = stack;
  // Leave room for the React component stack so that it is not cut off by a long JS stack.
  if (input.componentStack) fullStack = `${clip(stack, 900)}\nComponent stack:${input.componentStack}`;
  const props: InsightProps = {
    name: clip(name, ERROR_LIMITS.name),
    where: clip(input.where, ERROR_LIMITS.where),
    message: clip(message, ERROR_LIMITS.message),
    source,
    file,
    stack: clip(fullStack.trim(), ERROR_LIMITS.stack),
    path: clip(pathname, ERROR_LIMITS.path),
  };
  // line/col are optional ints (absent = null on the server).
  if (line !== null) props.line = line;
  if (col !== null) props.col = col;
  return props;
}
