import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { useLayoutEffect } from "react";
import { AnalyticsGate } from "./components/AnalyticsGate";
import { AppShell } from "./components/AppShell";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { CatalogProvider } from "./data/CatalogContext";
import { ConfigProvider } from "./data/ConfigContext";
import type { Lang } from "./domain/types";
import { detectLang, isLang } from "./i18n";
import { LangProvider } from "./i18n/LangContext";
import { Brochures } from "./pages/Brochures";
import { Catalog } from "./pages/Catalog";
import { Home } from "./pages/Home";
import { Legal } from "./pages/Legal";
import { OfferDetail } from "./pages/OfferDetail";
import { Search } from "./pages/Search";
import { hideSeoStatic, removeSeoStatic, setLang } from "./platform/document";
import { browserLanguages } from "./platform/env";
import { prefs } from "./platform/prefs";

/** Stored choice -> browser languages -> "ru". */
export function detectedLang(): Lang {
  return detectLang(prefs.get<string | null>("lang", null), browserLanguages());
}

const KNOWN_PAGES = new Set(["catalog", "search", "brochures", "offer", "legal", "c"]);

/** Where a path with a missing or invalid language prefix should go (query kept by the caller). */
export function redirectTarget(pathname: string, lang: Lang): string {
  const first = pathname.split("/")[1] ?? "";
  // "/catalog?x=1" (no language prefix) keeps its page.
  if (KNOWN_PAGES.has(first)) return `/${lang}${pathname}`;
  // "/xx/catalog" (invalid prefix) keeps the rest of the path.
  const rest = pathname.replace(/^\/[^/]*/, "").replace(/\/+$/, "");
  return `/${lang}${rest}`;
}

function RootRedirect() {
  const { pathname, search } = useLocation();
  return <Navigate to={`${redirectTarget(pathname, detectedLang())}${search}`} replace />;
}

/** Unknown page under a valid language prefix: go to that language's home. */
function UnknownUnderLang() {
  const { lang } = useParams();
  return <Navigate to={`/${isLang(lang) ? lang : detectedLang()}`} replace />;
}

function LangLayout() {
  const { lang } = useParams();
  // Layout effect: the html lang is set before any passive effect (first GA page_view) runs.
  useLayoutEffect(() => {
    if (isLang(lang)) setLang(lang);
  }, [lang]);
  if (!isLang(lang)) return <RootRedirect />;
  return (
    <LangProvider lang={lang}>
      <AppShell />
    </LangProvider>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/:lang" element={<LangLayout />}>
        <Route index element={<Home />} />
        <Route path="catalog" element={<Catalog />} />
        <Route path="c/:category" element={<Catalog />} />
        <Route path="search" element={<Search />} />
        <Route path="brochures" element={<Brochures />} />
        <Route path="offer/:id" element={<OfferDetail />} />
        <Route path="legal/:page" element={<Legal />} />
        <Route path="*" element={<UnknownUnderLang />} />
      </Route>
      <Route path="*" element={<RootRedirect />} />
    </Routes>
  );
}

export function App() {
  // The prerendered SEO block is hidden first, then removed, once React has mounted (no flash, no shift).
  useLayoutEffect(() => {
    hideSeoStatic();
    removeSeoStatic();
  }, []);
  return (
    <BrowserRouter>
      <ConfigProvider>
        <CatalogProvider>
          <AnalyticsGate />
          <ErrorBoundary>
            <AppRoutes />
          </ErrorBoundary>
        </CatalogProvider>
      </ConfigProvider>
    </BrowserRouter>
  );
}
