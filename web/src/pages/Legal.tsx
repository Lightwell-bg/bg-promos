import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { Navigate, useParams } from "react-router-dom";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { GridSkeleton } from "../components/Skeleton";
import { useLang } from "../i18n/LangContext";

export const LEGAL_PAGES = ["privacy", "cookies", "terms", "contacts"] as const;
type LegalPage = (typeof LEGAL_PAGES)[number];

// Each document is its own chunk: loaded only when the page is opened.
const loaders = import.meta.glob<{ default: ComponentType }>("../content/legal/*/*.tsx");
const cache = new Map<string, LazyExoticComponent<ComponentType>>();

function documentFor(lang: string, page: LegalPage): LazyExoticComponent<ComponentType> | null {
  const key = `../content/legal/${lang}/${page}.tsx`;
  const loader = loaders[key];
  if (!loader) return null;
  let c = cache.get(key);
  if (!c) {
    c = lazy(loader);
    cache.set(key, c);
  }
  return c;
}

/** Legal documents (privacy, cookies, terms, contacts) in the current language. */
export function Legal() {
  const { page } = useParams();
  const lang = useLang();
  if (!LEGAL_PAGES.includes(page as LegalPage)) return <Navigate to={`/${lang}`} replace />;
  const Doc = documentFor(lang, page as LegalPage);
  if (!Doc) return <Navigate to={`/${lang}`} replace />;
  return (
    <ErrorBoundary resetKey={`${lang}/${page}`}>
      <Suspense fallback={<GridSkeleton count={2} />}>
        <Doc />
      </Suspense>
    </ErrorBoundary>
  );
}
