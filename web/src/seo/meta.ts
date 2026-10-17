import type { Lang } from "../domain/types";
import { setMeta, setTitle } from "../platform/document";
import categories from "./categories.json";
import pages from "./pages.json";

export interface PageMeta {
  title: string;
  description: string;
}

export const SITE_URL = "https://promos.centerai.eu";
export const LEGAL_PAGES = ["privacy", "cookies", "terms", "contacts"] as const;

function fill(template: string, name: string): string {
  return template.replace(/\{name\}/g, name);
}

/**
 * Title and description for a route ("/bg", "/ru/catalog", "/bg/c/produce", "/ru/legal/terms").
 * null for routes without a static meta (offer pages set their own title).
 */
export function pageMeta(lang: Lang, pathname: string): PageMeta | null {
  const p = pages[lang];
  const [, , page, param] = pathname.replace(/\/+$/, "").split("/");
  if (!page) return p.home;
  if (page === "catalog" || page === "search" || page === "brochures") return p[page];
  if (page === "c") {
    const cat = categories.find((c) => c.id === param);
    if (!cat) return p.catalog;
    const name = cat[lang];
    return { title: fill(p.category.title, name), description: fill(p.category.description, name) };
  }
  if (page === "legal" && (LEGAL_PAGES as readonly string[]).includes(param)) {
    return p.legal[param as (typeof LEGAL_PAGES)[number]];
  }
  return null;
}

/** Sets <title>, meta description and canonical for the current route. */
export function applyPageMeta(meta: PageMeta, canonicalPath: string): void {
  setTitle(meta.title);
  setMeta({ description: meta.description, canonicalHref: `${SITE_URL}${canonicalPath}` });
}
