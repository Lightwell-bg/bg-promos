import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { recordVisit } from "./components/InstallHint";
import { isNativeShell } from "./platform/env";
import { initInstallPrompt } from "./platform/installPrompt";
import { captureLaunch } from "./platform/insights";
import { PREF_KEYS, prefs } from "./platform/prefs";
import "./styles/tokens.css";
import "./styles/global.css";

/** A stuck IndexedDB must not keep the app from rendering. */
const PREFS_TIMEOUT_MS = 800;

async function preloadPrefs(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, PREFS_TIMEOUT_MS);
  });
  try {
    await Promise.race([prefs.preload(PREF_KEYS).catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function start() {
  await preloadPrefs();
  recordVisit();
  initInstallPrompt();
  // Launch parameters (UTM, referrer, Telegram initData/start label) are read before the router rewrites
  // the address bar. Reading sends nothing: analytics starts only after consent.
  try {
    captureLaunch();
  } catch {
    /* never block the app */
  }
  // The prerendered #seo-static block is hidden and removed by <App> in a layout effect.
  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  // The service worker is for the web build only; native shells ship their own assets.
  if (!isNativeShell()) {
    const { registerSW } = await import("virtual:pwa-register");
    registerSW({ immediate: true });
  }
}

void start();
