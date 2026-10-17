import { useEffect } from "react";
import { track } from "../platform/analytics";
import { useCatalogState, useRefreshCatalog } from "../data/CatalogContext";
import { formatSofiaDateTime } from "../domain/dates";
import { CHAIN_IDS, CHAIN_NAMES } from "../domain/types";
import { useT } from "../i18n/LangContext";
import styles from "./StatusBanner.module.css";

/** Offline / stale-chain / fetch-error notices. */
export function StatusBanner() {
  const t = useT();
  const state = useCatalogState();
  const refresh = useRefreshCatalog();
  const offline = state.status === "offline";
  useEffect(() => {
    if (offline) track("offline_view");
  }, [offline]);
  const banners: { key: string; text: string; tone: "warn" | "danger"; retry?: boolean }[] = [];

  const fatal = state.status === "error";
  if (state.status === "offline") {
    const ts = state.lastCheckedAt ?? Date.parse(state.catalog?.generated_at ?? "");
    banners.push({
      key: "offline",
      text: t("banner.offline", { time: Number.isNaN(ts) ? "" : formatSofiaDateTime(ts) }),
      tone: "warn",
      retry: true,
    });
  }
  if (fatal) {
    banners.push({ key: "error", text: t("banner.error"), tone: "danger", retry: true });
  } else if (state.error && state.status !== "offline") {
    banners.push({ key: "errorCached", text: t("banner.errorCached"), tone: "warn", retry: true });
  }
  if (state.catalog) {
    for (const id of CHAIN_IDS) {
      if (state.catalog.chains[id]?.stale) {
        banners.push({ key: `stale-${id}`, text: t("banner.stale", { chain: CHAIN_NAMES[id] }), tone: "warn" });
      }
    }
  }
  if (!banners.length) return null;
  return (
    <div className={styles.wrap} role="status">
      {banners.map((b) => (
        <div key={b.key} className={`${styles.banner} ${b.tone === "danger" ? styles.danger : styles.warn}`}>
          <span>{b.text}</span>
          {b.retry && (
            <button type="button" className={styles.retry} onClick={refresh}>
              {t("common.retry")}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
