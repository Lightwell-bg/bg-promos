import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ConfigProvider } from "../data/ConfigContext";
import type { Lang } from "../domain/types";
import { LangProvider } from "../i18n/LangContext";
import { Legal } from "./Legal";

function renderLegal(lang: Lang, page: string) {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
  return render(
    <MemoryRouter initialEntries={[`/${lang}/legal/${page}`]}>
      <ConfigProvider>
        <LangProvider lang={lang}>
          <Routes>
            <Route path="/:lang/legal/:page" element={<Legal />} />
            <Route path="/:lang" element={<p>home</p>} />
          </Routes>
        </LangProvider>
      </ConfigProvider>
    </MemoryRouter>,
  );
}

describe("legal pages", () => {
  it.each(["bg", "ru"] as const)("%s privacy mentions the required facts", async (lang) => {
    const { container } = renderLegal(lang, "privacy");
    await screen.findByRole("heading", { level: 1 });
    const text = container.textContent ?? "";
    for (const needle of ["CenterAI", "info@centerai.eu", "17.10.2026", "https://www.cpdp.bg", "Telegram", "Google Ireland", "30", "14", "_ga"]) {
      expect(text).toContain(needle);
    }
    expect(text).toContain(lang === "bg" ? "КЗЛД" : "КЗЛД");
  });

  it.each(["bg", "ru"] as const)("%s cookies has the cookie table and the consent control", async (lang) => {
    const { container } = renderLegal(lang, "cookies");
    await screen.findByRole("heading", { level: 1 });
    expect(container.querySelectorAll("table").length).toBe(2);
    expect(container.textContent).toContain("_ga_*");
  });

  it.each(["bg", "ru"] as const)("%s terms and contacts render", async (lang) => {
    const t = renderLegal(lang, "terms");
    await screen.findByRole("heading", { level: 1 });
    expect(t.container.textContent).toMatch(/Lidl, Kaufland и BILLA/);
    t.unmount();
    const c = renderLegal(lang, "contacts");
    await screen.findByRole("heading", { level: 1 });
    expect(c.container.textContent).toContain("info@centerai.eu");
  });

  it("an unknown page goes home", async () => {
    renderLegal("bg", "nope");
    expect(await screen.findByText("home")).toBeInTheDocument();
  });
});
