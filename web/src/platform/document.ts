/** All access to the browser document (title, meta, html lang, static SEO block) lives here. */

export function setTitle(title: string): void {
  document.title = title;
}

export function setLang(lang: string): void {
  document.documentElement.lang = lang;
}

export function getLang(): string {
  return document.documentElement.lang;
}

/** Sets the meta description and the canonical link (both created when missing). */
export function setMeta(meta: { description: string; canonicalHref: string }): void {
  let d = document.head.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (!d) {
    d = document.createElement("meta");
    d.name = "description";
    document.head.appendChild(d);
  }
  d.content = meta.description;
  let c = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!c) {
    c = document.createElement("link");
    c.rel = "canonical";
    document.head.appendChild(c);
  }
  c.href = meta.canonicalHref;
}

export function reloadPage(): void {
  window.location.reload();
}

/** Hides the prerendered #seo-static block without removing it (no layout work yet). */
export function hideSeoStatic(): void {
  document.getElementById("seo-static")?.classList.add("seo-hidden");
}

/** Removes the prerendered #seo-static block that sits next to #root. */
export function removeSeoStatic(): void {
  document.getElementById("seo-static")?.remove();
}
