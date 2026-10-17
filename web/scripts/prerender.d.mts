export interface PrerenderPage {
  path: string;
  lang: "bg" | "ru";
  kind: string;
  meta: { title: string; description: string; h1: string; text: string };
}
export function esc(s: string): string;
export function buildPages(pages: unknown, categories: { id: string; bg: string; ru: string; icon: string }[]): PrerenderPage[];
export function alternates(p: PrerenderPage): [string, string][];
export function renderShell(template: string, parts: { lang: string; head: string; body: string }): string;
export function renderPage(template: string, p: PrerenderPage, pages: unknown, categories: unknown[]): string;
export function renderRoot(template: string, pages: unknown): string;
export function renderSitemap(list: PrerenderPage[], lastmod: string): string;
export function renderRobots(): string;
export function run(distDir?: string): Promise<number>;
