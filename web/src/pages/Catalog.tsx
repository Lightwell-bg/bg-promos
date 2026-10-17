import { useMemo, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { EmptyState } from "../components/EmptyState";
import { FilterChips } from "../components/FilterChips";
import { FilterSheet } from "../components/FilterSheet";
import { FilterIcon } from "../components/Icons";
import { OfferList } from "../components/OfferList";
import { GridSkeleton } from "../components/Skeleton";
import { useCatalog } from "../data/CatalogContext";
import { activeFilterCount, filterOffers, SORT_KEYS, type Filters, type SortKey } from "../domain/filters";
import { buildSearchIndex, searchOffers } from "../domain/search";
import { useFilters } from "../hooks/useFilters";
import { useLang, useT } from "../i18n/LangContext";
import { track } from "../platform/analytics";
import styles from "./Page.module.css";

/**
 * Catalog with filters in the URL. On "/:lang/c/:category" the category is fixed
 * (a canonical landing page for SEO) and the category filter is not offered.
 */
export function Catalog() {
  const t = useT();
  const lang = useLang();
  const { category } = useParams();
  const { catalog, offers, today, state } = useCatalog();
  const [urlFilters, setUrlFilters] = useFilters();
  const [sheet, setSheet] = useState(false);

  // On a category page the URL "cat" param is ignored: the route decides.
  const filters: Filters = category ? { ...urlFilters, cats: [] } : urlFilters;
  const effective: Filters = category ? { ...urlFilters, cats: [category] } : urlFilters;
  const setFilters = (f: Filters) => setUrlFilters(category ? { ...f, cats: [] } : f);

  const results = useMemo(() => {
    if (!catalog) return [];
    const ids = effective.q
      ? new Set(searchOffers(buildSearchIndex(catalog), effective.q).map((o) => o.id))
      : null;
    return filterOffers(offers, effective, today, ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, offers, urlFilters, category, today]);

  if (!catalog) {
    if (state.status === "error") return <EmptyState icon="📡" text={t("banner.error")} />;
    return <GridSkeleton />;
  }
  const current = category ? catalog.categories.find((c) => c.id === category) : undefined;
  if (category && !current) return <Navigate to={`/${lang}/catalog`} replace />;
  const count = activeFilterCount(filters);

  return (
    <div>
      <h1 className={styles.title}>{current ? `${current.icon} ${current[lang]}` : t("catalog.title")}</h1>
      {current && (
        <p className={styles.subtitle}>
          <Link to={`/${lang}/catalog`}>{t("category.all")}</Link>
        </p>
      )}
      <div className={styles.toolbar}>
        <button type="button" className={styles.filterBtn} onClick={() => setSheet(true)}>
          <FilterIcon />
          {t("catalog.filters")}
          {count > 0 && <span className={styles.count}>{count}</span>}
        </button>
        <select
          className={styles.select}
          aria-label={t("catalog.sort")}
          value={filters.sort}
          onChange={(e) => {
            const sort = e.target.value as SortKey;
            track("sort_change", { sort });
            setFilters({ ...filters, sort });
          }}
        >
          {SORT_KEYS.map((k) => (
            <option key={k} value={k}>
              {t(`sort.${k}`)}
            </option>
          ))}
        </select>
      </div>

      <FilterChips filters={filters} categories={catalog.categories} onChange={setFilters} />

      <p className={styles.resultCount} aria-live="polite">
        {t("catalog.results", { n: results.length })}
      </p>

      {results.length ? (
        <OfferList offers={results} categories={catalog.categories} today={today} card={effective.card} />
      ) : (
        <EmptyState icon={current?.icon ?? "🔍"} text={t(current && count === 0 ? "category.empty" : "catalog.noResults")} />
      )}

      {sheet && (
        <FilterSheet
          filters={filters}
          categories={catalog.categories}
          hideCategories={Boolean(category)}
          onClose={() => setSheet(false)}
          onApply={(f) => {
            // Counts only: filter values and the search text are never sent.
            track("filter_apply", { count: activeFilterCount(f) });
            setFilters(f);
            setSheet(false);
          }}
        />
      )}
    </div>
  );
}
