// Guards the production bug where offer images were blocked: the service worker fetches
// cross-origin images itself, and SW fetches are governed by CSP connect-src, not img-src.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const csp = readFileSync(resolve(root, "security-headers.conf"), "utf8");
const viteConfig = readFileSync(resolve(root, "vite.config.ts"), "utf8");

function directive(name: string): string[] {
  const m = csp.match(new RegExp(`${name}\\s+([^;]+);`));
  return m ? m[1].trim().split(/\s+/) : [];
}

function swImageHosts(): string[] {
  const block = viteConfig.match(/request\.destination === "image" &&\s*\[([^\]]+)\]/);
  if (!block) throw new Error("image runtimeCaching host list not found in vite.config.ts");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("CSP covers every image host cached by the service worker", () => {
  const hosts = swImageHosts();

  it("finds the SW image host list", () => {
    expect(hosts.length).toBeGreaterThan(0);
  });

  it.each(hosts)("%s is allowed in img-src and connect-src", (host) => {
    expect(directive("img-src")).toContain(`https://${host}`);
    expect(directive("connect-src")).toContain(`https://${host}`);
  });
});
