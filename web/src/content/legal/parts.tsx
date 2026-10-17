import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import styles from "./legal.module.css";

export const OPERATOR = "CenterAI";
export const CONTACT_EMAIL = "info@centerai.eu";
export const SITE_URL = "https://promos.centerai.eu";
export const UPDATED = "17.10.2026";
export const CPDP_URL = "https://www.cpdp.bg";

/** Wrapper for a legal document: title, "last updated" line, body. */
export function Doc({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <article className={styles.doc}>
      <h1 className={styles.h1}>{title}</h1>
      <p className={styles.updated}>{updated}</p>
      {children}
    </article>
  );
}

/** In-app link to another legal page. */
export function LegalLink({ lang, page, children }: { lang: "bg" | "ru"; page: string; children: ReactNode }) {
  return <Link to={`/${lang}/legal/${page}`}>{children}</Link>;
}

export function Mail() {
  return <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>;
}

export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** Horizontally scrollable table wrapper for narrow screens. */
export function Table({ children }: { children: ReactNode }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>{children}</table>
    </div>
  );
}
