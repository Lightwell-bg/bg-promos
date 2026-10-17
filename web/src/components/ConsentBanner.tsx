import { Link } from "react-router-dom";
import { useConfig } from "../data/ConfigContext";
import { useLang, useT } from "../i18n/LangContext";
import { saveConsent, useConsent } from "../platform/consent";
import { analyticsAvailable } from "./AnalyticsGate";
import styles from "./ConsentBanner.module.css";

/** Asks for analytics consent. Hidden when GA is not configured, in native shells, or once answered. */
export function ConsentBanner() {
  const t = useT();
  const lang = useLang();
  const { ga4_id } = useConfig();
  const consent = useConsent();
  if (!analyticsAvailable(ga4_id) || consent) return null;
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
