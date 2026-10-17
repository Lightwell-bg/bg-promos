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
