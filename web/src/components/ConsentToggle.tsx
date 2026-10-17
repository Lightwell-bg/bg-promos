import { useConfig } from "../data/ConfigContext";
import { useLang, useT } from "../i18n/LangContext";
import { saveConsent, useConsent } from "../platform/consent";
import { analyticsAvailable } from "./AnalyticsGate";
import styles from "./ConsentBanner.module.css";
import toggle from "./ConsentToggle.module.css";

/** Cookies page: switch analytics on or off. Revoking stops tracking and removes _ga cookies. */
export function ConsentToggle() {
  const t = useT();
  const lang = useLang();
  const { ga4_id } = useConfig();
  const consent = useConsent();
  if (!analyticsAvailable(ga4_id)) {
    return <p className={toggle.note}>{t("consent.unavailable")}</p>;
  }
  const on = consent?.choice === "granted";
  const state = consent ? t(on ? "consent.stateOn" : "consent.stateOff") : t("consent.stateUnset");
  const since = consent
    ? t("consent.since", {
        date: new Date(consent.at).toLocaleDateString(lang === "bg" ? "bg-BG" : "ru-RU"),
      })
    : null;
  return (
    <div className={toggle.box}>
      <div className={toggle.row}>
        <span id="consent-label" className={toggle.label}>
          {t("consent.toggle")}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby="consent-label"
          className={`${toggle.switch} ${on ? toggle.switchOn : ""}`}
          onClick={() => saveConsent(on ? "denied" : "granted")}
        >
          <span className={toggle.knob} />
        </button>
      </div>
      <p className={toggle.note}>
        {state}
        {since ? ` · ${since}` : ""}
      </p>
      <div className={`${styles.actions} ${toggle.actionsLeft}`}>
        <button type="button" className={styles.accept} onClick={() => saveConsent("granted")}>
          {t("consent.accept")}
        </button>
        <button type="button" className={styles.reject} onClick={() => saveConsent("denied")}>
          {t("consent.reject")}
        </button>
      </div>
    </div>
  );
}
