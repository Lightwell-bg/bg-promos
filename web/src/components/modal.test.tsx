import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FILTERS } from "../domain/filters";
import { LangProvider } from "../i18n/LangContext";
import { FilterSheet } from "./FilterSheet";
import { ConfigProvider } from "../data/ConfigContext";
import { ReportDialog } from "./ReportDialog";

function Host({ kind }: { kind: "filters" | "report" }) {
  const [open, setOpen] = useState(false);
  return (
    <ConfigProvider>
      <LangProvider lang="bg">
        <header>
          <button type="button" onClick={() => setOpen(true)}>
            opener
          </button>
        </header>
        <main>
          <a href="/x">outside link</a>
        </main>
        {open && kind === "filters" && (
          <FilterSheet filters={DEFAULT_FILTERS} categories={[]} onApply={() => undefined} onClose={() => setOpen(false)} />
        )}
        {open && kind === "report" && <ReportDialog offerId={null} onClose={() => setOpen(false)} />}
      </LangProvider>
    </ConfigProvider>
  );
}

async function open(kind: "filters" | "report") {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
  render(<Host kind={kind} />);
  const opener = screen.getByRole("button", { name: "opener" });
  await userEvent.click(opener);
  return { opener, dialog: screen.getByRole("dialog") };
}

describe.each(["filters", "report"] as const)("%s modal accessibility", (kind) => {
  it("moves focus inside on open and makes the background inert", async () => {
    const { dialog } = await open(kind);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(screen.getByRole("banner", { hidden: true })).toHaveAttribute("inert");
    expect(screen.getByRole("main", { hidden: true })).toHaveAttribute("inert");
  });

  it("Tab and Shift+Tab cycle inside the dialog", async () => {
    const { dialog } = await open(kind);
    // More presses than the dialog has controls: focus must wrap around, never escape.
    const count = dialog.querySelectorAll("button, input, textarea").length + 3;
    for (let i = 0; i < count; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < count; i++) {
      await userEvent.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  }, 30_000);

  it("Escape closes it, restores focus and removes inert", async () => {
    const { opener } = await open(kind);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
    expect(screen.getByRole("main")).not.toHaveAttribute("inert");
  });
});
