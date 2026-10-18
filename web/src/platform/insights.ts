import { apiUrl } from "../data/api";
import {
  INSIGHT_EVENTS,
  landingSource,
  parseInitData,
  parseStartParam,
  parseUtm,
  referrerOrigin,
  startLabel,
  type InsightName,
  type InsightProps,
  type UtmKey,
} from "../domain/insightEvents";
import { localKv } from "./localKv";

/**
 * Internal analytics client (docs/ANALYTICS.md). Everything here is inert until `startInsights()`
 * is called, which the AnalyticsGate does only after the single analytics consent. It never
 * throws into the UI: every failure is swallowed.
 */

export const AID_KEY = "bgpromos:aid";
export const TEST_KEY = "bgpromos:test";
export const BATCH_MAX = 50;
export const FLUSH_MS = 5_000;
/** Total number of sends of one event (the first try included) before it is dropped. */
export const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 2_000;
const QUEUE_CAP = 200;
const ERROR_CAP = 20;

export type Platform = "web" | "miniapp";

/** What the app was opened with; captured once, before the router can rewrite the address. */
export interface Launch {
  initData: string | null;
  startLabel: string | null;
  utm: Partial<Record<UtmKey, string>>;
  referrer: string | null;
  test: boolean;
}

export interface SessionInfo {
  visitorId: string;
  platform: Platform;
  sourceKind: string;
  campaign: string | null;
}

interface QueuedEvent {
  event_id: string;
  name: InsightName;
  ts: string;
  props: InsightProps;
  attempts: number;
}

const ALLOWED = new Set<string>(INSIGHT_EVENTS);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let sessionLang = "bg";

let launch: Launch | null = null;
let active = false;
let dead = false;
let started = false;
let sessionId: string | null = null;
let token: string | null = null;
let info: SessionInfo | null = null;
let listener: ((s: SessionInfo) => void) | null = null;
let queue: QueuedEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
/** Bumped on stop: answers of requests from an earlier life are ignored. */
let generation = 0;
const seenOnce = new Set<string>();
const recent = new Map<string, number>();
let errorCount = 0;

/** Random UUID; falls back to getRandomValues / Math.random where randomUUID is missing (http, old webviews). */
export function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Telegram.WebApp.initData if the telegram-web-app script happens to be present (we never add it). */
function sdkInitData(): string | null {
  const v = (globalThis as { Telegram?: { WebApp?: { initData?: unknown } } }).Telegram?.WebApp?.initData;
  return typeof v === "string" && v ? v : null;
}

/**
 * Reads the launch parameters once (call it before rendering). Reading is not tracking: nothing is
 * sent or stored except the manual `?bgtest=1` test flag.
 */
export function captureLaunch(): Launch {
  if (launch) return launch;
  const { search, hash } = window.location;
  const sp = new URLSearchParams(search);
  const flag = sp.get("bgtest");
  if (flag === "1") localKv.set(TEST_KEY, true);
  else if (flag === "0") localKv.remove(TEST_KEY);
  launch = {
    initData: parseInitData(hash) ?? sdkInitData(),
    startLabel: startLabel(parseStartParam(search, hash)),
    utm: parseUtm(search),
    referrer: referrerOrigin(document.referrer, window.location.hostname),
    test: localKv.get<boolean>(TEST_KEY) === true,
  };
  return launch;
}

/** "miniapp" when Telegram launched the app with initData, else "web". */
export function currentPlatform(): Platform {
  return captureLaunch().initData ? "miniapp" : "web";
}

/** Anonymous visitor id of the site; created on first use (only after consent). */
function anonId(): string {
  const v = localKv.get<unknown>(AID_KEY);
  // The backend accepts only a UUID (36 chars); anything else is regenerated.
  if (typeof v === "string" && UUID_RE.test(v)) return v;
  const id = uuid();
  localKv.set(AID_KEY, id);
  return id;
}

function sessionBody(id: string, lang: string): Record<string, unknown> {
  const l = captureLaunch();
  const body: Record<string, unknown> = { session_id: id, lang, platform: currentPlatform(), utm: {} };
  if (l.initData) {
    // Telegram identity is established by the server from the signed initData only.
    body.init_data = l.initData;
    if (l.startLabel) body.start_param = l.startLabel;
  } else {
    body.anon_id = anonId();
    body.utm = l.utm;
    if (l.referrer) body.referrer = l.referrer;
  }
  if (l.test) body.test = true;
  return body;
}

function postJson(path: string, body: unknown, keepalive = false): Promise<Response> {
  return fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    keepalive,
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function openSession(id: string, lang: string, gen: number): Promise<void> {
  const body = sessionBody(id, lang);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await postJson("/api/v1/analytics/session", body);
      if (gen !== generation) return;
      if (res.ok) {
        const data = (await res.json()) as {
          token?: unknown;
          visitor_id?: unknown;
          source?: { kind?: unknown; campaign?: unknown } | null;
        };
        if (gen !== generation) return;
        if (typeof data.token !== "string" || typeof data.visitor_id !== "string") break;
        token = data.token;
        const l = captureLaunch();
        const land = landingSource(l.utm, l.startLabel, l.referrer);
        info = {
          visitorId: data.visitor_id,
          platform: currentPlatform(),
          sourceKind: typeof data.source?.kind === "string" ? data.source.kind : land.kind,
          campaign: typeof data.source?.campaign === "string" ? data.source.campaign : land.campaign,
        };
        listener?.(info);
        schedule(queue.length >= BATCH_MAX ? 0 : FLUSH_MS);
        return;
      }
      if (res.status < 500 && res.status !== 429) break; // refused: do not hammer
    } catch {
      /* network failure: retry */
    }
    if (attempt < MAX_ATTEMPTS) {
      await wait(RETRY_BASE_MS * 2 ** (attempt - 1));
      if (gen !== generation) return;
    }
  }
  if (gen === generation) {
    // No session: analytics stays off for this page load; nothing is retried forever.
    dead = true;
    queue = [];
    clearTimer();
  }
}

/**
 * The events endpoint answered 401 (token unknown: server restarted, secret changed): call
 * /session again with the SAME session_id to get a fresh token. Single attempt; the caller
 * re-queues the batch (same event_ids), so nothing is double counted.
 */
async function reauth(gen: number): Promise<void> {
  if (!sessionId) return;
  try {
    const res = await postJson("/api/v1/analytics/session", sessionBody(sessionId, sessionLang));
    if (gen !== generation) return;
    if (res.ok) {
      const data = (await res.json()) as { token?: unknown };
      if (gen === generation && typeof data.token === "string") token = data.token;
    }
  } catch {
    /* the batch is retried later, bounded by MAX_ATTEMPTS */
  }
}

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function schedule(ms: number): void {
  if (timer !== null || !active || dead || !token || queue.length === 0) return;
  timer = setTimeout(() => void flush(), ms);
}

function payload(batch: QueuedEvent[]): unknown {
  return {
    token,
    session_id: sessionId,
    events: batch.map(({ event_id, name, ts, props }) => ({ event_id, name, ts, props })),
  };
}

/** The server refuses bodies over 32 KB (413): stay well below it, with room for token + session id. */
export const BATCH_MAX_BYTES = 28_000;

function byteLength(s: string): number {
  return typeof TextEncoder !== "undefined" ? new TextEncoder().encode(s).length : s.length * 3;
}

/**
 * Takes the next batch off the queue: up to BATCH_MAX events AND at most BATCH_MAX_BYTES of
 * serialized events (detailed app_error events are large). At least one event is always taken;
 * a single event is clipped by the builders far below the limit.
 */
function takeBatch(): QueuedEvent[] {
  let bytes = 0;
  let n = 0;
  for (const e of queue) {
    if (n >= BATCH_MAX) break;
    const size = byteLength(JSON.stringify({ event_id: e.event_id, name: e.name, ts: e.ts, props: e.props })) + 1;
    if (n > 0 && bytes + size > BATCH_MAX_BYTES) break;
    bytes += size;
    n++;
  }
  return queue.splice(0, n);
}

/** Sends one batch; on a network error / 5xx the SAME event_ids go back to the queue (bounded). */
export async function flush(): Promise<void> {
  clearTimer();
  if (!active || dead || !token || flushing || queue.length === 0) return;
  flushing = true;
  const gen = generation;
  const batch = takeBatch();
  let retry = false;
  try {
    const res = await postJson("/api/v1/analytics/events", payload(batch));
    if (gen !== generation) return;
    // 200 ok; 400 (rejected events) / 413 are final: resending the same payload cannot succeed.
    retry = res.status >= 500 || res.status === 429 || res.status === 401;
    if (res.status === 401) {
      await reauth(gen);
      if (gen !== generation) return;
    }
  } catch {
    if (gen !== generation) return;
    retry = true;
  } finally {
    if (gen === generation) {
      flushing = false;
      let delay = FLUSH_MS;
      if (retry) {
        const kept = batch.map((e) => ({ ...e, attempts: e.attempts + 1 })).filter((e) => e.attempts < MAX_ATTEMPTS);
        if (kept.length) {
          queue.unshift(...kept);
          delay = RETRY_BASE_MS * 2 ** (kept[0].attempts - 1);
        }
      }
      schedule(queue.length >= BATCH_MAX && !retry ? 0 : delay);
    }
  }
}

/** Page is going away: hand everything to sendBeacon / keepalive fetch (no retries possible). */
export function flushOnHide(): void {
  if (!active || dead || !token || queue.length === 0) return;
  clearTimer();
  while (queue.length) {
    const batch = takeBatch();
    const body = JSON.stringify(payload(batch));
    const url = apiUrl("/api/v1/analytics/events");
    let sent = false;
    try {
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        sent = navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      }
    } catch {
      sent = false;
    }
    if (!sent) {
      try {
        void fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          credentials: "same-origin",
          keepalive: true,
        }).catch(() => undefined);
      } catch {
        /* ignore */
      }
    }
  }
}

let hideAttached = false;
function attachHideListener(): void {
  if (hideAttached || typeof document === "undefined") return;
  hideAttached = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushOnHide();
  });
}

/**
 * Starts the session (once per app load; StrictMode / repeated calls are harmless). Call it only
 * after consent. Events recorded before the server answers wait in the queue.
 */
export function startInsights(lang: string): void {
  active = true;
  attachHideListener();
  if (started) {
    schedule(FLUSH_MS); // resumed after suspendInsights(): same anonymous id and session
    return;
  }
  started = true;
  dead = false;
  sessionId = uuid();
  sessionLang = lang === "ru" ? "ru" : "bg";
  void openSession(sessionId, sessionLang, generation).catch(() => undefined);
}

/**
 * Pause without forgetting (the /admin area): pending events are handed over, nothing more is
 * recorded or sent, but `bgpromos:aid` and the session stay, so coming back continues the same
 * visitor and session.
 */
export function suspendInsights(): void {
  flushOnHide();
  active = false;
  clearTimer();
}

/** Consent withdrawn: stop, forget the anonymous id, the queue and the session. */
export function revokeInsights(): void {
  generation++;
  active = false;
  started = false;
  dead = false;
  sessionId = null;
  token = null;
  info = null;
  queue = [];
  flushing = false;
  clearTimer();
  seenOnce.clear();
  recent.clear();
  errorCount = 0;
  try {
    localKv.remove(AID_KEY);
  } catch {
    /* ignore */
  }
}

export function isInsightsActive(): boolean {
  return active && !dead;
}

/** Registers the (single) listener for the session answer; called at once when it is already known. */
export function setSessionListener(cb: ((s: SessionInfo) => void) | null): void {
  listener = cb;
  if (cb && info) cb(info);
}

export function getSessionInfo(): SessionInfo | null {
  return info;
}

export interface RecordOptions {
  /** Record this event name at most once per session. */
  once?: boolean;
  /** Skip an identical (name + props) event repeated within this many ms (StrictMode double effects). */
  dedupeMs?: number;
}

/**
 * Queues one logical event with a fresh event_id. Returns false when nothing was queued
 * (not started, no consent, unknown name, duplicate). Never throws.
 */
export function record(name: InsightName, props: InsightProps = {}, opts: RecordOptions = {}): boolean {
  try {
    if (!active || dead || !ALLOWED.has(name)) return false;
    if (opts.once) {
      if (seenOnce.has(name)) return false;
    }
    if (opts.dedupeMs) {
      const key = `${name}:${JSON.stringify(props)}`;
      const now = Date.now();
      const last = recent.get(key);
      if (last !== undefined && now - last < opts.dedupeMs) return false;
      recent.set(key, now);
    }
    if (name === "app_error" && ++errorCount > ERROR_CAP) return false;
    if (opts.once) seenOnce.add(name);
    queue.push({ event_id: uuid(), name, ts: new Date().toISOString(), props, attempts: 0 });
    if (queue.length > QUEUE_CAP) queue.shift();
    if (queue.length >= BATCH_MAX && token) void flush();
    else schedule(FLUSH_MS);
    return true;
  } catch {
    return false;
  }
}

/** Test helper: forget everything (module state survives between tests otherwise). */
export function resetInsightsForTests(): void {
  revokeInsights();
  launch = null;
  listener = null;
}
