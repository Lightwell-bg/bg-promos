import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useConfig } from "../data/ConfigContext";
import { noopAnalytics, setAnalytics } from "../platform/analytics";
import { useConsent } from "../platform/consent";
import { getLang } from "../platform/document";
import { isNativeShell } from "../platform/env";
import { createGoogleAnalytics, type GoogleAnalytics } from "../platform/ga";

/** True when analytics may be offered at all: a GA4 id is configured and this is the web build. */
export function analyticsAvailable(ga4Id: string | null | undefined): ga4Id is string {
  return Boolean(ga4Id) && !isNativeShell();
}

/**
 * Connects GA4 to the consent choice. Renders nothing.
 * No id -> analytics fully off. No/denied consent -> nothing from Google is loaded.
 */
export function AnalyticsGate() {
  const { ga4_id } = useConfig();
  const consent = useConsent();
  const { pathname } = useLocation();
  const gaRef = useRef<GoogleAnalytics | null>(null);
  const granted = analyticsAvailable(ga4_id) && consent?.choice === "granted";

  useEffect(() => {
    if (granted && ga4_id) {
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
  }, [granted, ga4_id]);

  // page_view is sent manually on every route change (path only, no query string).
  useEffect(() => {
    if (granted && gaRef.current?.isEnabled()) {
      gaRef.current.pageView(pathname, getLang() || undefined);
    }
  }, [granted, pathname]);

  return null;
}
