/**
 * Microsoft Clarity (session replay / heatmaps). Loaded once, only after the analytics consent and
 * only when the server configured a project id. Personal UI is masked with `data-clarity-mask`.
 * Nothing but opaque ids, enum-like tags and event names is ever passed to Clarity.
 */

type ClarityFn = ((...args: unknown[]) => void) & { q?: unknown[] };

const PROJECT_ID = /^[a-z0-9]{1,32}$/i;

let loadedId: string | null = null;
let granted = false;
/** Set by stopClarity(): this page load must never (re)start the recorder; a reload resets it. */
let stopped = false;

function api(): ClarityFn | undefined {
  return (window as unknown as { clarity?: ClarityFn }).clarity;
}

function call(...args: unknown[]): void {
  try {
    api()?.(...args);
  } catch {
    /* never break the app */
  }
}

/** True when the Clarity tag was injected in this page load. */
export function clarityLoaded(): boolean {
  return loadedId !== null;
}

/**
 * Injects https://www.clarity.ms/tag/<id> once per page load (SPA navigation never re-inits it).
 * Returns false when the id is invalid. Call only after consent.
 */
export function loadClarity(id: string, doc: Document = document): boolean {
  if (!PROJECT_ID.test(id) || stopped) return false;
  if (loadedId !== null) return true;
  loadedId = id;
  const w = window as unknown as { clarity?: ClarityFn };
  if (!w.clarity) {
    const stub: ClarityFn = function (...args: unknown[]) {
      (stub.q = stub.q || []).push(args);
    };
    w.clarity = stub;
  }
  const s = doc.createElement("script");
  s.async = true;
  s.crossOrigin = "anonymous";
  s.src = `https://www.clarity.ms/tag/${encodeURIComponent(id)}`;
  doc.head.appendChild(s);
  return true;
}

/**
 * Withdraws consent from the running recorder (`consent` false + consent mode v2 denied) and blocks
 * any later or still pending init in this page. Clarity cannot be unloaded, so the caller must
 * follow up with a hard reload. Returns true when the tag had been loaded in this page.
 */
export function stopClarity(): boolean {
  granted = false;
  if (loadedId === null) return false; // never started in this page: nothing to stop
  stopped = true;
  call("consent", false);
  call("consentv2", { ad_Storage: "denied", analytics_Storage: "denied" });
  return true;
}

/** Consent Mode v2: analytics storage granted, ad storage always denied. No-op until Clarity is loaded. */
export function clarityConsent(on: boolean): void {
  if (loadedId === null) return;
  granted = on;
  call("consentv2", { ad_Storage: "denied", analytics_Storage: on ? "granted" : "denied" });
}

export function clarityTag(key: string, value: string | null | undefined): void {
  if (!granted || !value) return;
  call("set", key, value);
}

/** Custom event by name only (no properties). */
export function clarityEvent(name: string): void {
  if (!granted) return;
  call("event", name);
}

/** Identifies the visitor by the opaque server-side id (never a Telegram id, name or username). */
export function clarityIdentify(visitorId: string): void {
  if (!granted || !/^v_[a-z0-9]{6,40}$/i.test(visitorId)) return;
  call("identify", visitorId);
}

/** Test helper. */
export function resetClarityForTests(): void {
  loadedId = null;
  granted = false;
  stopped = false;
  delete (window as unknown as { clarity?: ClarityFn }).clarity;
}
