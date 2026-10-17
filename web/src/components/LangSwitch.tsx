import { useLocation, useNavigate } from "react-router-dom";
import { LANGS, type Lang } from "../domain/types";
import { useLang, useT } from "../i18n/LangContext";
import { track } from "../platform/analytics";
import { prefs } from "../platform/prefs";
import styles from "./LangSwitch.module.css";

/** BG/RU switch: keeps the current path and query, remembers the choice. */
export function LangSwitch() {
  const lang = useLang();
  const t = useT();
  const navigate = useNavigate();
  const { pathname, search, hash } = useLocation();

  function pick(l: Lang) {
    if (l === lang) return;
    prefs.set("lang", l);
    track("lang_switch", { lang: l });
    const rest = pathname.replace(/^\/[^/]+/, "");
    navigate(`/${l}${rest}${search}${hash}`, { replace: true });
  }

  return (
    <div className={styles.group} role="group" aria-label={t("lang.label")}>
      {LANGS.map((l) => (
        <button
          key={l}
          type="button"
          className={`${styles.btn} ${l === lang ? styles.on : ""}`}
          aria-pressed={l === lang}
          onClick={() => pick(l)}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
