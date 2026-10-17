interface CapacitorGlobal {
  Capacitor?: { isNativePlatform?: () => boolean };
}

/** True inside a Capacitor native shell. */
export function isNativeShell(): boolean {
  return (window as unknown as CapacitorGlobal).Capacitor?.isNativePlatform?.() === true;
}

/** True when launched as an installed PWA. */
export function isStandalone(): boolean {
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  } catch {
    /* ignore */
  }
  return (navigator as unknown as { standalone?: boolean }).standalone === true;
}

export function browserLanguages(): readonly string[] {
  if (navigator.languages?.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

export function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  const webkit = /WebKit/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return ios && webkit;
}

export function currentUrl(): string {
  return window.location.href;
}

/** Current page without query string and hash (safe to send to the backend or analytics). */
export function currentPageUrl(): string {
  return window.location.origin + window.location.pathname;
}

export function isOnline(): boolean {
  return navigator.onLine !== false;
}

/** Origin of the page (scheme + host), used to build absolute share links. */
export function siteOrigin(): string {
  return window.location.origin;
}

/** Current location hash including the leading "#" ("" when none). */
export function locationHash(): string {
  return window.location.hash;
}

/** Drops the hash from the address bar without navigating or reloading. */
export function clearLocationHash(): void {
  try {
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  } catch {
    /* ignore: some webviews forbid history changes */
  }
}

const START_PARAM = "tgWebAppStartParam";

function paramFrom(raw: string): string | null {
  const s = raw.replace(/^[?#]/, "");
  for (const kv of s.split("&")) {
    const i = kv.indexOf("=");
    if (i > 0 && kv.slice(0, i) === START_PARAM) {
      try {
        return decodeURIComponent(kv.slice(i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Telegram Mini App start parameter: query string first, then the hash (some clients put it there). */
export function telegramStartParam(): string | null {
  return paramFrom(window.location.search) ?? paramFrom(window.location.hash);
}

function without(raw: string, lead: string): string {
  const s = raw.replace(/^[?#]/, "");
  if (!s) return "";
  const kept = s.split("&").filter((kv) => kv.split("=")[0] !== START_PARAM);
  return kept.length ? lead + kept.join("&") : "";
}

/** Removes tgWebAppStartParam from the address bar (other query/hash parameters stay). */
export function clearTelegramStartParam(): void {
  try {
    const { pathname, search, hash } = window.location;
    window.history.replaceState(window.history.state, "", pathname + without(search, "?") + without(hash, "#"));
  } catch {
    /* ignore: some webviews forbid history changes */
  }
}
