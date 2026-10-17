// Build-time prerender (no SSR framework): run after `vite build`.
// Writes static HTML shells from dist/index.html for the public routes with their own
// <title>, description, canonical, hreflang, Open Graph/Twitter tags and a small static
// content block (h1 + text + links) that the React app removes on mount.
// Also writes dist/root.html (served for "/"), dist/sitemap.xml and dist/robots.txt.
//
// dist/index.html itself is NOT modified: the service worker precaches it (with a
// revision hash) and uses it as the offline app shell for every route.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = (process.env.SITE_URL || "https://promos.centerai.eu").replace(/\/+$/, "");
const LANGS = ["bg", "ru"];
const LEGAL = ["privacy", "cookies", "terms", "contacts"];
const LOCALE = { bg: "bg_BG", ru: "ru_RU" };

async function readJson(rel) {
  return JSON.parse(await readFile(path.join(root, rel), "utf-8"));
}

export function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fill(template, name) {
  return template.replace(/\{name\}/g, name);
}

/** All prerendered pages: { path, lang, meta, kind }. Paths have no trailing slash. */
export function buildPages(pages, categories) {
  const out = [];
  for (const lang of LANGS) {
    const p = pages[lang];
    out.push({ path: `/${lang}`, lang, kind: "home", meta: p.home });
    for (const k of ["catalog", "search", "brochures"]) {
      out.push({ path: `/${lang}/${k}`, lang, kind: k, meta: p[k] });
    }
    for (const c of categories) {
      const name = c[lang];
      out.push({
        path: `/${lang}/c/${c.id}`,
        lang,
        kind: "category",
        meta: {
          title: fill(p.category.title, name),
          description: fill(p.category.description, name),
          h1: fill(p.category.h1, name),
          text: fill(p.category.text, name),
        },
      });
    }
    for (const l of LEGAL) {
      out.push({ path: `/${lang}/legal/${l}`, lang, kind: "legal", meta: p.legal[l] });
    }
  }
  return out;
}

/** The same page in the other language. */
function otherLangPath(p) {
  return p.path.replace(/^\/(bg|ru)/, (_, l) => `/${l === "bg" ? "ru" : "bg"}`);
}

/** hreflang alternates: [hreflang, absolute url]. x-default: "/" for the home pair, ru elsewhere. */
export function alternates(p) {
  const bg = p.lang === "bg" ? p.path : otherLangPath(p);
  const ru = p.lang === "ru" ? p.path : otherLangPath(p);
  const xDefault = p.kind === "home" ? `${SITE}/` : `${SITE}${ru}`;
  return [
    ["bg", `${SITE}${bg}`],
    ["ru", `${SITE}${ru}`],
    ["x-default", xDefault],
  ];
}

function jsonLd(lang) {
  const data = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "BG Promos",
    url: `${SITE}/${lang}`,
    inLanguage: lang,
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: `${SITE}/${lang}/search?q={search_term_string}` },
      "query-input": "required name=search_term_string",
    },
  };
  // "<" is escaped so the JSON can never close the script element.
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

function headTags({ title, description, canonical, lang, alts, locale, localeAlt, withLd }) {
  const image = `${SITE}/og-image.png`;
  const lines = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    `<link rel="canonical" href="${esc(canonical)}" />`,
    ...alts.map(([l, href]) => `<link rel="alternate" hreflang="${l}" href="${esc(href)}" />`),
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="BG Promos" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${esc(canonical)}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:locale" content="${locale}" />`,
    ...(localeAlt ? [`<meta property="og:locale:alternate" content="${localeAlt}" />`] : []),
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
    `<meta name="twitter:image" content="${image}" />`,
  ];
  if (withLd) lines.push(`<script type="application/ld+json">${jsonLd(lang)}</script>`);
  return lines.map((l) => `    ${l}`).join("\n");
}

function link(href, label) {
  return `<li><a href="${esc(href)}">${esc(label)}</a></li>`;
}

function staticBlock(p, pages, categories) {
  const L = pages[p.lang];
  const lang = p.lang;
  const other = lang === "bg" ? "ru" : "bg";
  const items = [
    link(`/${lang}`, L.nav.home),
    link(`/${lang}/catalog`, L.nav.catalog),
    link(`/${lang}/search`, L.nav.search),
    link(`/${lang}/brochures`, L.nav.brochures),
  ];
  const sections = [`<nav aria-label="${esc(L.nav.home)}"><ul>${items.join("")}</ul></nav>`];
  if (p.kind === "home" || p.kind === "catalog" || p.kind === "category") {
    const cats = categories.map((c) => link(`/${lang}/c/${c.id}`, `${c.icon} ${c[lang]}`));
    sections.push(`<nav aria-label="${esc(L.nav.categories)}"><ul>${cats.join("")}</ul></nav>`);
  }
  const legal = LEGAL.map((l) => link(`/${lang}/legal/${l}`, pages[lang].legal[l].h1));
  sections.push(`<nav aria-label="${esc(L.nav.legal)}"><ul>${legal.join("")}</ul></nav>`);
  sections.push(`<p><a href="${esc(otherLangPath(p))}" hreflang="${other}">${other.toUpperCase()}</a></p>`);
  return `<div id="seo-static">
      <main>
        <h1>${esc(p.meta.h1)}</h1>
        <p>${esc(p.meta.text)}</p>
        ${sections.join("\n        ")}
      </main>
    </div>`;
}

function requireAnchor(html, re, what) {
  if (!re.test(html)) throw new Error(`prerender: ${what} not found in dist/index.html`);
}

/** Turns the app shell into a page with its own head and static content. */
export function renderShell(template, { lang, head, body }) {
  requireAnchor(template, /<html lang="[^"]*">/, "<html lang>");
  requireAnchor(template, /<title>[\s\S]*?<\/title>/, "<title>");
  requireAnchor(template, /<meta name="description"[^>]*>/, "meta description");
  requireAnchor(template, /<div id="root"><\/div>/, '<div id="root">');
  requireAnchor(template, /<\/head>/, "</head>");
  return template
    .replace(/<html lang="[^"]*">/, `<html lang="${lang}">`)
    .replace(/\s*<title>[\s\S]*?<\/title>/, "")
    .replace(/\s*<meta name="description"[^>]*>/, "")
    .replace("</head>", () => `${head}\n  </head>`)
    .replace('<div id="root"></div>', () => `<div id="root"></div>\n    ${body}`);
}

export function renderPage(template, p, pages, categories) {
  const lang = p.lang;
  const head = headTags({
    title: p.meta.title,
    description: p.meta.description,
    canonical: `${SITE}${p.path}`,
    lang,
    alts: alternates(p),
    locale: LOCALE[lang],
    localeAlt: LOCALE[lang === "bg" ? "ru" : "bg"],
    withLd: p.kind === "home",
  });
  return renderShell(template, { lang, head, body: staticBlock(p, pages, categories) });
}

/** "/" : x-default page with links to /bg and /ru; the app redirects by stored/browser language. */
export function renderRoot(template, pages) {
  const title = "BG Promos — Lidl, Kaufland, BILLA";
  const description =
    "Промоции на Lidl, Kaufland и BILLA в България / Акции Lidl, Kaufland и BILLA в Болгарии: цены, скидки, брошюры.";
  const alts = [
    ["bg", `${SITE}/bg`],
    ["ru", `${SITE}/ru`],
    ["x-default", `${SITE}/`],
  ];
  const head = headTags({
    title,
    description,
    canonical: `${SITE}/`,
    lang: "bg",
    alts,
    locale: LOCALE.bg,
    localeAlt: LOCALE.ru,
    withLd: true,
  });
  const body = `<div id="seo-static">
      <main>
        <h1>BG Promos</h1>
        <p lang="bg">${esc(pages.bg.home.text)}</p>
        <p lang="ru">${esc(pages.ru.home.text)}</p>
        <nav aria-label="BG / RU"><ul>
          <li><a href="/bg" hreflang="bg" lang="bg">Български</a></li>
          <li><a href="/ru" hreflang="ru" lang="ru">Русский</a></li>
        </ul></nav>
      </main>
    </div>`;
  return renderShell(template, { lang: "bg", head, body });
}

export function renderSitemap(list, lastmod) {
  const alt = (l, href) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${esc(href)}"/>`;
  const entry = (loc, alts) =>
    `  <url>\n    <loc>${esc(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n${alts.map(([l, h]) => alt(l, h)).join("\n")}\n  </url>`;
  const entries = [
    entry(`${SITE}/`, [
      ["bg", `${SITE}/bg`],
      ["ru", `${SITE}/ru`],
      ["x-default", `${SITE}/`],
    ]),
    ...list.map((p) => entry(`${SITE}${p.path}`, alternates(p))),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries.join("\n")}\n</urlset>\n`;
}

export function renderRobots() {
  return `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE}/sitemap.xml\n`;
}

async function writePage(dist, urlPath, html) {
  const dir = path.join(dist, ...urlPath.split("/").filter(Boolean));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.html"), html, "utf-8");
}

export async function run(distDir = path.join(root, "dist")) {
  const template = await readFile(path.join(distDir, "index.html"), "utf-8");
  const pages = await readJson("src/seo/pages.json");
  const categories = await readJson("src/seo/categories.json");
  const list = buildPages(pages, categories);
  for (const p of list) await writePage(distDir, p.path, renderPage(template, p, pages, categories));
  await writeFile(path.join(distDir, "root.html"), renderRoot(template, pages), "utf-8");
  const lastmod = new Date().toISOString().slice(0, 10);
  await writeFile(path.join(distDir, "sitemap.xml"), renderSitemap(list, lastmod), "utf-8");
  await writeFile(path.join(distDir, "robots.txt"), renderRobots(), "utf-8");
  console.log(`prerender: ${list.length} pages + root.html, sitemap.xml (${list.length + 1} URLs), robots.txt`);
  return list.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
