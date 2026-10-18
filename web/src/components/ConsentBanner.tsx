import { Link } from "react-router-dom";
import { useConfig } from "../data/ConfigContext";
import { useLang, useT } from "../i18n/LangContext";
import { saveConsent, useConsent } from "../platform/consent";
import { analyticsAvailable } from "./AnalyticsGate";
import styles from "./ConsentBanner.module.css";

/**
 * The single analytics consent (GA4, Microsoft Clarity and internal statistics). Hidden when no analytics
 * is configured, in native shells, or once answered (the choice is stored for 12 months). In-page markup
 * only - no window.confirm, so it works inside the Telegram Mini App webview.
 */
export function ConsentBanner() {
  const t = useT();
  const lang = useLang();
  const cfg = useConfig();
  const consent = useConsent();
  if (!analyticsAvailable(cfg) || consent) return null;
  return (
    <section className={styles.banner} aria-label={t("consent.title")}>
      <p className={styles.text}>
        {t("consent.text")}{" "}
        <Link to={`/${lang}/legal/cookies`} className={styles.link}>
          {t("consent.more")}
        </Link>
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.reject} onClick={() => saveConsent("denied")}>
          {t("consent.reject")}
        </button>
        <button type="button" className={styles.accept} onClick={() => saveConsent("granted")}>
          {t("consent.accept")}
        </button>
      </div>
    </section>
  );
}
