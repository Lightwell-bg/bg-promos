// Guards the production bug where offer images were blocked: when the service worker
// fetched cross-origin images itself, they fell under CSP connect-src and depended on the
// SW version installed on the device. Images must be loaded by the browser directly.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const csp = readFileSync(resolve(root, "security-headers.conf"), "utf8");
const viteConfig = readFileSync(resolve(root, "vite.config.ts"), "utf8");

// Every image host present in the collected data (Kaufland, Lidl).
const IMAGE_HOSTS = ["kaufland.media.schwarz", "imgproxy-retcat.assets.schwarz", "media.kaufland.com", "www.lidl.bg"];

function directive(name: string): string[] {
  const m = csp.match(new RegExp(`${name}\\s+([^;"]+)[;"]`));
  return m ? m[1].trim().split(/\s+/) : [];
}

describe("offer images", () => {
  it("are not routed through the service worker", () => {
    expect(viteConfig).not.toMatch(/request\.destination\s*===\s*"image"/);
    expect(viteConfig).not.toMatch(/offer-images/);
    for (const host of IMAGE_HOSTS) expect(viteConfig).not.toContain(`"${host}"`);
  });

  it("takes over open pages immediately after an update", () => {
    expect(viteConfig).toMatch(/skipWaiting:\s*true/);
    expect(viteConfig).toMatch(/clientsClaim:\s*true/);
  });

  it("can be embedded only by itself and Telegram Web (mini app)", () => {
    expect(directive("frame-ancestors")).toEqual(["'self'", "https://web.telegram.org", "https://*.telegram.org"]);
  });

  it.each(IMAGE_HOSTS)("%s is allowed by CSP img-src", (host) => {
    expect(directive("img-src")).toContain(`https://${host}`);
  });
});

describe("Microsoft Clarity", () => {
  it.each(["script-src", "connect-src", "img-src"])("%s allows clarity.ms and keeps the rest", (name) => {
    const hosts = directive(name);
    expect(hosts).toContain("https://www.clarity.ms");
    expect(hosts).toContain("https://*.clarity.ms");
    expect(hosts).toContain("'self'");
  });

  it("keeps GA4 allowed and object-src closed", () => {
    expect(directive("script-src")).toContain("https://www.googletagmanager.com");
    expect(directive("object-src")).toEqual(["'none'"]);
  });
});
