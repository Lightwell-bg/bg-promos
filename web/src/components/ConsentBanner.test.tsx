import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigProvider, FALLBACK_CONFIG } from "../data/ConfigContext";
import { LangProvider } from "../i18n/LangContext";
import { noopAnalytics, setAnalytics } from "../platform/analytics";
import { resetConsentCache } from "../platform/consent";
import { prefs } from "../platform/prefs";
import { AnalyticsGate } from "./AnalyticsGate";
import { ConsentBanner } from "./ConsentBanner";
import { ConsentToggle } from "./ConsentToggle";

const scripts = () => document.querySelectorAll('script[src*="googletagmanager.com"]');

function setup(ga4: string | null) {
  prefs.set("config", { ...FALLBACK_CONFIG, ga4_id: ga4 });
  return render(
    <MemoryRouter initialEntries={["/bg"]}>
      <ConfigProvider>
        <LangProvider lang="bg">
          <AnalyticsGate />
          <ConsentBanner />
          <ConsentToggle />
        </LangProvider>
      </ConfigProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
  document.head.innerHTML = "";
  delete (window as unknown as { dataLayer?: unknown }).dataLayer;
  prefs.remove("consent");
  resetConsentCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setAnalytics(noopAnalytics);
});

describe("ConsentBanner + AnalyticsGate", () => {
  it("no ga4 id: no banner and nothing is loaded", () => {
    setup(null);
    expect(screen.queryByRole("button", { name: "Приемам", hidden: false })).toBeNull();
    expect(scripts()).toHaveLength(0);
  });

  it("shows the banner but loads nothing before a choice", () => {
    setup("G-ABC123");
    expect(screen.getAllByRole("button", { name: "Приемам" }).length).toBeGreaterThan(0);
    expect(scripts()).toHaveLength(0);
  });

  it("reject keeps Google unloaded and hides the banner", async () => {
    setup("G-ABC123");
    await userEvent.click(screen.getAllByRole("button", { name: "Отказвам" })[0]);
    expect(scripts()).toHaveLength(0);
    expect(document.querySelector("section[aria-label]")).toBeNull();
  });

  it("accept injects gtag.js with the id; revoking in the toggle stops tracking", async () => {
    setup("G-ABC123");
    await userEvent.click(screen.getAllByRole("button", { name: "Приемам" })[0]);
    expect(scripts()).toHaveLength(1);
    expect((scripts()[0] as HTMLScriptElement).src).toContain("id=G-ABC123");
    const layerLen = () => ((window as unknown as { dataLayer: unknown[] }).dataLayer ?? []).length;
    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "true");
    await userEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "false");
    const after = layerLen();
    const { track } = await import("../platform/analytics");
    track("brochure_click", { chain: "lidl" });
    expect(layerLen()).toBe(after);
  });
});
