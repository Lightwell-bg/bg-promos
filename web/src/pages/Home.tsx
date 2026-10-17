import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState } from "../components/EmptyState";
import { OfferCard } from "../components/OfferCard";
import { HomeSkeleton } from "../components/Skeleton";
import { SearchIcon } from "../components/Icons";
import { useCatalog } from "../data/CatalogContext";
import { daysLeft, status } from "../domain/dates";
import { compareOffers } from "../domain/filters";
import { newOffers } from "../domain/newOffers";
import { CHAIN_IDS, CHAIN_NAMES, type ChainId, type Offer } from "../domain/types";
import { useBrochureLinks } from "../hooks/useBrochureLinks";
import { useLang, useT } from "../i18n/LangContext";
import { track } from "../platform/analytics";
import { openExternal } from "../platform/openExternal";
import { prefs } from "../platform/prefs";
import styles from "./Page.module.css";

const RAIL_LIMIT = 20;

type ChainPref = "all" | ChainId;

export function Home() {
  const t = useT();
  const lang = useLang();
  const { catalog, offers, today, state } = useCatalog();
  const brochures = useBrochureLinks();
  const [chain, setChain] = useState<ChainPref>(() => prefs.get<ChainPref>("chain", "all"));

  function pickChain(c: ChainPref) {
    setChain(c);
    prefs.set("chain", c);
  }

  const rails = useMemo(() => {
    const active = offers.filter(
      (o) => status(o, today) === "active" && (chain === "all" || o.chain === chain),
    );
    const top = active
      .filter((o) => o.best?.discount_pct != null)
      .sort(compareOffers("discount"))
      .slice(0, RAIL_LIMIT);
    const ending = active
      .filter((o) => {
        const left = daysLeft(o, today);
        return left != null && left >= 0 && left <= 2;
      })
      .sort((a, b) => compareOffers("ending")(a, b) || compareOffers("discount")(a, b))
      .slice(0, RAIL_LIMIT);
    // A chain's initial import is not "new": see domain/newOffers.
    const fresh = newOffers(active, catalog?.offers ?? offers, Date.now()).slice(0, RAIL_LIMIT);
    const counts = new Map<string, number>();
    for (const o of active) counts.set(o.category, (counts.get(o.category) ?? 0) + 1);
    return { top, ending, fresh, counts };
  }, [offers, catalog, today, chain]);

  if (!catalog) {
    if (state.status === "error") return <EmptyState icon="📡" text={t("banner.error")} />;
    return <HomeSkeleton />;
  }
  const catQuery = chain === "all" ? "" : `?chain=${chain}`;

  const rail = (title: string, list: Offer[], to: string) => (
    <section className={styles.section} key={title}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{title}</h2>
        <Link to={to} className={styles.seeAll}>
          {t("home.seeAll")}
        </Link>
      </div>
      {list.length ? (
        <div className={styles.rail}>
          {list.map((o) => (
            <OfferCard
              key={o.id}
              offer={o}
              rail
              today={today}
              category={catalog.categories.find((c) => c.id === o.category)}
            />
          ))}
        </div>
      ) : (
        <EmptyState icon="🛍️" text={t("home.empty")} />
      )}
    </section>
  );

  const chainQ = chain === "all" ? "" : `&chain=${chain}`;
  return (
    <div>
      <div className={styles.sticky}>
        <Link to={`/${lang}/search`} className={styles.searchBox}>
          <SearchIcon />
          <span>{t("home.searchPlaceholder")}</span>
        </Link>
      </div>

      <div className={styles.chainPills} role="group" aria-label={t("chain.label")}>
        {(["all", ...CHAIN_IDS] as ChainPref[]).map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={chain === c}
            className={`${styles.pill} ${chain === c ? styles.pillOn : ""}`}
            onClick={() => pickChain(c)}
          >
            {c === "all" ? t("chain.all") : CHAIN_NAMES[c]}
          </button>
        ))}
      </div>

      {rail(t("home.rail.top"), rails.top, `/${lang}/catalog?sort=discount${chainQ}`)}

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>{t("home.categories")}</h2>
        </div>
        <div className={styles.rail}>
          {catalog.categories
            .filter((c) => (rails.counts.get(c.id) ?? 0) > 0)
            .map((c) => (
              <Link key={c.id} to={`/${lang}/c/${c.id}${catQuery}`} className={styles.cat}>
                <span className={styles.catIcon} aria-hidden="true">
                  {c.icon}
                </span>
                <span className={styles.catLabel}>{c[lang]}</span>
                <span className={styles.catCount}>{rails.counts.get(c.id)}</span>
              </Link>
            ))}
          <Link to={`/${lang}/catalog${catQuery}`} className={styles.cat}>
            <span className={styles.catIcon} aria-hidden="true">
              🗂️
            </span>
            <span className={styles.catLabel}>{t("category.all")}</span>
            <span className={styles.catCount} />
          </Link>
        </div>
      </section>

      {rail(t("home.rail.ending"), rails.ending, `/${lang}/catalog?sort=ending&ends=3${chainQ}`)}
      {rail(t("home.rail.new"), rails.fresh, `/${lang}/catalog${chainQ ? `?${chainQ.slice(1)}` : ""}`)}

      {brochures.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>{t("home.brochures")}</h2>
          <div className={styles.pills}>
            {brochures.map((b) => (
              <a
                key={b.chain}
                href={b.url}
                className={styles.secondaryBtn}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.preventDefault();
                  track("brochure_click", { chain: b.chain });
                  openExternal(b.url);
                }}
              >
                {CHAIN_NAMES[b.chain]}
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
