import { ChainBadge } from "../components/ChainBadge";
import { ExternalIcon } from "../components/Icons";
import { CHAIN_NAMES } from "../domain/types";
import { useBrochureLinks } from "../hooks/useBrochureLinks";
import { useT } from "../i18n/LangContext";
import { track } from "../platform/analytics";
import { openExternal } from "../platform/openExternal";
import styles from "./Page.module.css";

export function Brochures() {
  const t = useT();
  const links = useBrochureLinks();
  return (
    <div>
      <h1 className={styles.title}>{t("brochures.title")}</h1>
      <div className={styles.stack}>
        {links.map((b) => (
          <a
            key={b.chain}
            href={b.url}
            className={styles.linkCard}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              e.preventDefault();
              track("brochure_click", { chain: b.chain });
              openExternal(b.url);
            }}
          >
            <span>
              <ChainBadge chain={b.chain} />
              <span className={styles.linkCardTitle}> {t("brochures.open")}</span>
              <br />
              <span className={styles.linkCardDesc}>{t("brochures.desc", { chain: CHAIN_NAMES[b.chain] })}</span>
            </span>
            <ExternalIcon />
          </a>
        ))}
      </div>
    </div>
  );
}
