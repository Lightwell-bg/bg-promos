import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../../scripts/prerender.mjs";
import categories from "./categories.json";

const TEMPLATE = `<!doctype html>
<html lang="bg">
  <head>
    <meta charset="UTF-8" />
    <meta name="description" content="x" />
    <title>BG Promos</title>
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

let dir = "";
const read = (rel: string) => readFile(path.join(dir, rel), "utf-8");

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "bgp-prerender-"));
  await writeFile(path.join(dir, "index.html"), TEMPLATE, "utf-8");
  await run(dir);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("prerender", () => {
  it("writes every public route", () => {
    const paths = ["bg", "ru", "bg/catalog", "ru/catalog", "bg/search", "ru/search", "bg/brochures", "ru/brochures"];
    for (const l of ["bg", "ru"]) {
      for (const c of categories) paths.push(`${l}/c/${c.id}`);
      for (const p of ["privacy", "cookies", "terms", "contacts"]) paths.push(`${l}/legal/${p}`);
    }
    expect(paths).toHaveLength(8 + 2 * categories.length + 8);
    for (const p of paths) expect(existsSync(path.join(dir, p, "index.html")), p).toBe(true);
    expect(existsSync(path.join(dir, "root.html"))).toBe(true);
  });

  it("leaves the app shell index.html untouched", async () => {
    expect(await read("index.html")).toBe(TEMPLATE);
  });

  it("home page: lang, title, canonical, hreflang, OG/Twitter, JSON-LD SearchAction", async () => {
    const html = await read("bg/index.html");
    expect(html).toContain('<html lang="bg">');
    expect(html).toMatch(/<title>BG Promos — промоции/);
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html.match(/name="description"/g)).toHaveLength(1);
    expect(html).toContain('<link rel="canonical" href="https://promos.centerai.eu/bg" />');
    expect(html).toContain('hreflang="bg" href="https://promos.centerai.eu/bg"');
    expect(html).toContain('hreflang="ru" href="https://promos.centerai.eu/ru"');
    expect(html).toContain('hreflang="x-default" href="https://promos.centerai.eu/"');
    expect(html).toContain('property="og:image" content="https://promos.centerai.eu/og-image.png"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]);
    expect(ld["@type"]).toBe("WebSite");
    expect(ld.potentialAction.target.urlTemplate).toBe("https://promos.centerai.eu/bg/search?q={search_term_string}");
    expect(html).toContain('<div id="root"></div>');
    expect(html).toMatch(/<div id="seo-static">[\s\S]*<h1>/);
    expect(html).not.toContain("<noscript");
  });

  it("category page is in the right language with its own canonical", async () => {
    const html = await read("ru/c/dairy_eggs/index.html");
    expect(html).toContain('<html lang="ru">');
    expect(html).toContain("Молочное, сыры и яйца");
    expect(html).toContain('rel="canonical" href="https://promos.centerai.eu/ru/c/dairy_eggs"');
    expect(html).toContain('hreflang="bg" href="https://promos.centerai.eu/bg/c/dairy_eggs"');
    expect(html).not.toContain("application/ld+json");
  });

  it("root.html links to /bg and /ru and is the x-default", async () => {
    const html = await read("root.html");
    expect(html).toContain('href="/bg"');
    expect(html).toContain('href="/ru"');
    expect(html).toContain('rel="canonical" href="https://promos.centerai.eu/"');
  });

  it("sitemap lists all URLs with alternates; robots allows all except /api/", async () => {
    const xml = await read("sitemap.xml");
    const n = (xml.match(/<loc>/g) ?? []).length;
    expect(n).toBe(1 + 8 + 2 * categories.length + 8);
    expect(xml).toContain("<loc>https://promos.centerai.eu/</loc>");
    expect(xml).toContain('hreflang="x-default"');
    const robots = await read("robots.txt");
    expect(robots).toContain("Allow: /");
    expect(robots).toContain("Disallow: /api/");
    expect(robots).toContain("Sitemap: https://promos.centerai.eu/sitemap.xml");
  });

  it("the closed /admin section is neither prerendered nor in the sitemap", async () => {
    expect(existsSync(path.join(dir, "admin"))).toBe(false);
    expect(await read("sitemap.xml")).not.toContain("/admin");
  });
});
