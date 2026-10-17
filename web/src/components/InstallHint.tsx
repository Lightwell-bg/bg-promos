import { useEffect, useState, useSyncExternalStore } from "react";
import { useT } from "../i18n/LangContext";
import { track } from "../platform/analytics";
import { isIosSafari, isNativeShell, isStandalone } from "../platform/env";
import { canPromptInstall, promptInstall, subscribeInstallPrompt } from "../platform/installPrompt";
import { prefs } from "../platform/prefs";
import styles from "./InstallHint.module.css";

const DISMISS_MS = 14 * 24 * 60 * 60 * 1000;
const MIN_VISITS = 3;

/** Counts one visit per page load. Call once at startup. */
export function recordVisit(): void {
  prefs.set("visits", prefs.get<number>("visits", 0) + 1);
}

/** "Add to home screen" hint: after 3+ visits, not dismissed in 14 days, not installed. */
export function InstallHint() {
  const t = useT();
  const canPrompt = useSyncExternalStore(subscribeInstallPrompt, canPromptInstall);
  const [hidden, setHidden] = useState(false);

  const ios = isIosSafari();
  const eligible =
    !hidden &&
    !isStandalone() &&
    !isNativeShell() &&
    prefs.get<number>("visits", 0) >= MIN_VISITS &&
    Date.now() - prefs.get<number>("installDismissedAt", 0) > DISMISS_MS &&
    (canPrompt || ios);

  useEffect(() => {
    if (eligible) track("install_prompt_shown", { platform: canPrompt ? "android" : "ios" });
  }, [eligible, canPrompt]);

  if (!eligible) return null;

  function dismiss() {
    prefs.set("installDismissedAt", Date.now());
    setHidden(true);
  }
  async function install() {
    const outcome = await promptInstall();
    if (outcome === "accepted") track("install_prompt_accepted");
    dismiss();
  }

  return (
    <aside className={styles.hint} aria-label={t("install.title")}>
      <p className={styles.text}>{canPrompt ? t("install.title") : t("install.ios")}</p>
      <div className={styles.actions}>
        {canPrompt && (
          <button type="button" className={styles.primary} onClick={install}>
            {t("install.button")}
          </button>
        )}
        <button type="button" className={styles.later} onClick={dismiss}>
          {t("install.later")}
        </button>
      </div>
    </aside>
  );
}
