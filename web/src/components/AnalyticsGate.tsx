import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useCatalog } from "../data/CatalogContext";
import { useConfig } from "../data/ConfigContext";
import type { AppConfig } from "../domain/types";
import { installGlobalErrorHandlers, noopAnalytics, record, setAnalytics } from "../platform/analytics";
import { clarityConsent, clarityIdentify, clarityTag, loadClarity, stopClarity } from "../platform/clarity";
import { useConsent } from "../platform/consent";
import { getLang, reloadPage } from "../platform/document";
import { isNativeShell } from "../platform/env";
import { createGoogleAnalytics, type GoogleAnalytics } from "../platform/ga";
import {
  captureLaunch,
  currentPlatform,
  getSessionInfo,
  setSessionListener,
  revokeInsights,
  startInsights,
  suspendInsights,
  type SessionInfo,
} from "../platform/insights";
import { landingSource } from "../domain/insightEvents";

/** True when at least one analytics channel (GA4, Clarity, internal) is configured and this is the web build. */
export function analyticsAvailable(cfg: Pick<AppConfig, "ga4_id" | "clarity_id" | "analytics_enabled">): boolean {
  return (Boolean(cfg.ga4_id) || Boolean(cfg.clarity_id) || cfg.analytics_enabled === true) && !isNativeShell();
}

/** Clarity tags: only enum-like values (lang, platform, source kind, campaign label). */
function applyClarityTags(info: SessionInfo | null): void {
  const l = captureLaunch();
  const land = landingSource(l.utm, l.startLabel, l.referrer);
  clarityTag("lang", getLang() === "ru" ? "ru" : "bg");
  clarityTag("platform", currentPlatform());
  clarityTag("source_kind", info?.sourceKind ?? land.kind);
  clarityTag("campaign", info?.campaign ?? land.campaign);
}

/**
 * Connects GA4, Clarity and the internal analytics to the single consent choice. Renders nothing.
 * No consent (or a refusal) -> nothing is requested from anyone. The admin area is never tracked.
 */
export function AnalyticsGate() {
  const { ga4_id, clarity_id, analytics_enabled } = useConfig();
  const consent = useConsent();
  const { pathname } = useLocation();
  const gaRef = useRef<GoogleAnalytics | null>(null);
  const available = analyticsAvailable({ ga4_id, clarity_id, analytics_enabled });
  const consented = available && consent?.choice === "granted";
  const onAdmin = pathname.startsWith("/admin");
  const granted = consented && !onAdmin;
  const gaOn = granted && Boolean(ga4_id);
  const clarityOn = granted && Boolean(clarity_id);
  const internalOn = granted && analytics_enabled === true;
  const consentGranted = consent?.choice === "granted";

  // Google Analytics 4.
  useEffect(() => {
    if (gaOn && ga4_id) {
      if (!gaRef.current || gaRef.current.id !== ga4_id) {
        gaRef.current?.disable();
        gaRef.current = createGoogleAnalytics(ga4_id);
      }
      gaRef.current.enable();
      setAnalytics(gaRef.current);
      return;
    }
    gaRef.current?.disable();
    setAnalytics(noopAnalytics);
  }, [gaOn, ga4_id]);

  // page_view is sent manually on every route change (path only, no query string).
  useEffect(() => {
    if (gaOn && gaRef.current?.isEnabled()) {
      gaRef.current.pageView(pathname, getLang() || undefined);
    }
  }, [gaOn, pathname]);

  // Internal analytics: one session per app load (module-level guard, StrictMode-safe).
  useEffect(() => {
    if (internalOn) {
      setSessionListener((s) => {
        clarityIdentify(s.visitorId);
        applyClarityTags(s);
      });
      startInsights(getLang());
      installGlobalErrorHandlers();
    } else if (consentGranted) {
      // /admin (or analytics unavailable): pause only, the anonymous id and the session stay
      setSessionListener(null);
      suspendInsights();
    } else {
      // consent withdrawn / never given: forget the anonymous id, the queue and the session
      setSessionListener(null);
      revokeInsights();
    }
  }, [internalOn, consentGranted]);

  // Microsoft Clarity: loaded once, consent mode v2, opaque id only.
  useEffect(() => {
    if (clarityOn && clarity_id) {
      if (loadClarity(clarity_id)) {
        clarityConsent(true);
        applyClarityTags(getSessionInfo());
        const s = getSessionInfo();
        if (s) clarityIdentify(s.visitorId);
      }
    } else if (stopClarity()) {
      // Consent withdrawn, or /admin entered, while the recorder runs in this page: it cannot be
      // unloaded, so a hard reload is the only way to stop it (Clarity never runs on /admin).
      reloadPage();
    }
  }, [clarityOn, clarity_id]);

  return null;
}

/**
 * `catalog_loaded`: the catalog was shown (cache or network) - once per session. A consent given
 * later still reports it. Needs the CatalogProvider; renders nothing.
 */
export function CatalogLoadedReporter() {
  const { offers, state } = useCatalog();
  const consent = useConsent();
  const { analytics_enabled } = useConfig();
  const { pathname } = useLocation();
  const on = analytics_enabled === true && consent?.choice === "granted" && !pathname.startsWith("/admin");
  const hasCatalog = state.catalog !== null;
  const offersCount = offers.length;
  const fromCache = state.status !== "ready";
  useEffect(() => {
    if (on && hasCatalog) record("catalog_loaded", { offers: offersCount, from_cache: fromCache }, { once: true });
  }, [on, hasCatalog, offersCount, fromCache]);
  return null;
}
