import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { EmptyState } from "../components/EmptyState";
import { OfferList } from "../components/OfferList";
import { GridSkeleton } from "../components/Skeleton";
import { useCatalog } from "../data/CatalogContext";
import { buildSearchIndex, searchOffers, suggest } from "../domain/search";
import { useLang, useT } from "../i18n/LangContext";
import { searchProps } from "../domain/insightEvents";
import { record, track } from "../platform/analytics";
import { prefs } from "../platform/prefs";
import styles from "./Page.module.css";
import local from "./Search.module.css";

const RECENT_MAX = 8;

function loadRecent(): string[] {
  const v = prefs.get<unknown>("recentQueries", []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
}

export function Search() {
  const t = useT();
  const lang = useLang();
  const { catalog, offers, today, state } = useCatalog();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  // The committed text lives in router state (history state), never in the address bar. `?q=` is
  // still accepted on entry (SEO SearchAction) but is moved into state at once and stripped.
  const stateQ = (location.state as { q?: unknown } | null)?.q;
  const entryQ = params.get("q");
  const committed = typeof stateQ === "string" ? stateQ : (entryQ ?? "");
  const [text, setText] = useState(committed);
  const [recent, setRecent] = useState<string[]>(loadRecent);

  useEffect(() => setText(committed), [committed]);

  useEffect(() => {
    if (entryQ === null) return;
    const q = entryQ.trim() ? entryQ : null;
    navigate(location.pathname, { replace: true, state: q ? { q } : null });
  }, [entryQ]); // eslint-disable-line react-hooks/exhaustive-deps

  const index = useMemo(() => (catalog ? buildSearchIndex(catalog) : null), [catalog]);

  const results = useMemo(() => {
    if (!index || !committed.trim()) return [];
    // `offers` already excludes ended ones; keep the relevance order from the index.
    const visible = new Set(offers.map((o) => o.id));
    return searchOffers(index, committed).filter((o) => visible.has(o.id));
  }, [index, committed, offers]);

  const hasResultsData = index !== null;
  useEffect(() => {
    // GA4: never the query text, only its length and the number of results. Internal analytics:
    // the (normalised) text only when nothing was found (docs/ANALYTICS.md).
    if (committed.trim() && hasResultsData) {
      track("search", { len: committed.trim().length, results: results.length });
      record("search", searchProps(committed, results.length), { dedupeMs: 1500 });
    }
  }, [committed, hasResultsData]); // eslint-disable-line

  const suggestions = useMemo(
    () => (index && text.trim() && text.trim() !== committed.trim() ? suggest(index, text) : null),
    [index, text, committed],
  );

  function commit(q: string) {
    const query = q.trim();
    if (!query) {
      // Empty commit: back to the initial search screen; not a recent search.
      setText("");
      navigate(location.pathname, { replace: true, state: null });
      return;
    }
    setText(query);
    navigate(location.pathname, { replace: true, state: { q: query } });
    const next = [query, ...recent.filter((r) => r.toLowerCase() !== query.toLowerCase())].slice(0, RECENT_MAX);
    setRecent(next);
    prefs.set("recentQueries", next);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    commit(text);
  }

  function clearRecent() {
    setRecent([]);
    prefs.set("recentQueries", []);
  }

  return (
    <div>
      <h1 className={styles.title}>{t("search.title")}</h1>
      {/* Typed text, suggestions, recent searches and the results header are personal: masked in Clarity. */}
      <div data-clarity-mask="true">
      <div className={styles.sticky}>
        <form onSubmit={onSubmit} role="search" className={local.form}>
          <input
            type="search"
            className={local.input}
            value={text}
            placeholder={t("search.placeholder")}
            aria-label={t("search.title")}
            autoComplete="off"
            enterKeyHint="search"
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className={styles.primaryBtn}>
            {t("search.submit")}
          </button>
        </form>
      </div>

      {suggestions && (
        <ul className={local.suggest} aria-label={t("search.suggestions")}>
          {suggestions.terms.map((s) => (
            <li key={`t-${s}`}>
              <button type="button" className={local.item} onClick={() => commit(s)}>
                {s}
              </button>
            </li>
          ))}
          {suggestions.categories.map((c) => (
            <li key={`c-${c.id}`}>
              <Link className={local.item} to={`/${lang}/c/${c.id}`}>
                {c.icon} {c[lang]}
              </Link>
            </li>
          ))}
          {suggestions.brands.map((b) => (
            <li key={`b-${b}`}>
              <button type="button" className={local.item} onClick={() => commit(b)}>
                {b}
              </button>
            </li>
          ))}
        </ul>
      )}

      {!committed && !suggestions && (
        <>
          {recent.length > 0 && (
            <section className={styles.section}>
              <div className={styles.sectionHead}>
                <h2 className={styles.sectionTitle}>{t("search.recent")}</h2>
                <button type="button" className={local.link} onClick={clearRecent}>
                  {t("search.clearRecent")}
                </button>
              </div>
              <div className={styles.pills}>
                {recent.map((r) => (
                  <button key={r} type="button" className={styles.pill} onClick={() => commit(r)}>
                    {r}
                  </button>
                ))}
              </div>
            </section>
          )}
          <p className={styles.resultCount}>{t("search.hint")}</p>
        </>
      )}

      {!catalog && state.status !== "loading" && <EmptyState icon="📡" text={t("banner.error")} />}
      {!catalog && state.status === "loading" && committed && <GridSkeleton />}

      {committed && catalog && !suggestions && (
        <p className={styles.resultCount} aria-live="polite">
          {t("search.results", { n: results.length })}
        </p>
      )}
      </div>

      {committed && catalog && !suggestions && (
        <>
          {results.length ? (
            <OfferList offers={results} categories={catalog.categories} today={today} />
          ) : (
            <EmptyState icon="🔎" text={t("search.noResults")} />
          )}
        </>
      )}
    </div>
  );
}
