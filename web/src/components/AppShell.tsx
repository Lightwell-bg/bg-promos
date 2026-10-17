import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import logoFull from "../assets/logo-full.svg";
import { useLang, useT } from "../i18n/LangContext";
import { applyPageMeta, pageMeta } from "../seo/meta";
import styles from "./AppShell.module.css";
import { ConsentBanner } from "./ConsentBanner";
import { ErrorBoundary } from "./ErrorBoundary";
import { BrochureIcon, CatalogIcon, HomeIcon, SearchIcon } from "./Icons";
import { InstallHint } from "./InstallHint";
import { LangSwitch } from "./LangSwitch";
import { ReportDialog } from "./ReportDialog";
import { StatusBanner } from "./StatusBanner";

const LEGAL = ["privacy", "cookies", "terms", "contacts"] as const;

export function AppShell() {
  const t = useT();
  const lang = useLang();
  const { pathname } = useLocation();
  const [reporting, setReporting] = useState(false);

  // <title>, description and canonical follow the route (offer pages set their own title).
  useEffect(() => {
    const meta = pageMeta(lang, pathname);
    if (meta) applyPageMeta(meta, pathname.replace(/\/+$/, "") || `/${lang}`);
  }, [lang, pathname]);

  const nav = [
    { to: `/${lang}`, end: true, label: t("nav.home"), icon: <HomeIcon /> },
    { to: `/${lang}/catalog`, end: false, label: t("nav.catalog"), icon: <CatalogIcon /> },
    { to: `/${lang}/search`, end: false, label: t("nav.search"), icon: <SearchIcon /> },
    { to: `/${lang}/brochures`, end: false, label: t("nav.brochures"), icon: <BrochureIcon /> },
  ];

  return (
    <div className={styles.shell}>
      <header className={styles.top}>
        <Link to={`/${lang}`} className={styles.logo} aria-label={t("app.name")}>
          <img src={logoFull} alt="" className={styles.logoImg} width={125} height={32} />
        </Link>
        <LangSwitch />
        {/* Overlay anchored to the sticky top bar: takes no space in the page flow (CLS). */}
        <StatusBanner />
      </header>
      <main className={styles.main} key={pathname.split("/")[2] ?? "home"}>
        <ErrorBoundary resetKey={pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
      <footer className={styles.footer}>
        <nav className={styles.legal}>
          {LEGAL.map((p) => (
            <Link key={p} to={`/${lang}/legal/${p}`}>
              {t(`footer.${p}`)}
            </Link>
          ))}
          <button type="button" className={styles.reportBtn} onClick={() => setReporting(true)}>
            {t("footer.report")}
          </button>
        </nav>
      </footer>
      <ConsentBanner />
      <InstallHint />
      <nav className={styles.bottom} aria-label={t("nav.label")}>
        {nav.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) => `${styles.tab} ${isActive ? styles.active : ""}`}
          >
            {n.icon}
            <span>{n.label}</span>
          </NavLink>
        ))}
      </nav>
      {reporting && <ReportDialog offerId={null} onClose={() => setReporting(false)} />}
    </div>
  );
}
