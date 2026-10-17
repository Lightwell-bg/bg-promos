import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as doc from "../platform/document";
import { session } from "../platform/session";
import { ErrorBoundary, isChunkLoadError, reloadOnceForChunkError } from "./ErrorBoundary";

function Boom({ error }: { error: Error }): never {
  throw error;
}

beforeEach(() => {
  session.remove("chunkReloadAt");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("ErrorBoundary", () => {
  it("renders the friendly fallback with a reload button", () => {
    document.documentElement.lang = "ru";
    render(
      <ErrorBoundary>
        <Boom error={new Error("render failed")} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Перезагрузить" })).toBeInTheDocument();
    document.documentElement.lang = "bg";
  });

  it("uses Bulgarian by default", () => {
    document.documentElement.lang = "bg";
    render(
      <ErrorBoundary>
        <Boom error={new Error("x")} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("button", { name: "Презареди" })).toBeInTheDocument();
  });

  it("reloads once for a chunk-load error, not for other errors", () => {
    const reload = vi.spyOn(doc, "reloadPage").mockImplementation(() => undefined);
    const chunk = new TypeError("Failed to fetch dynamically imported module: /assets/x.js");
    expect(isChunkLoadError(chunk)).toBe(true);
    expect(isChunkLoadError(Object.assign(new Error("x"), { name: "ChunkLoadError" }))).toBe(true);
    expect(isChunkLoadError(new Error("boom"))).toBe(false);

    expect(reloadOnceForChunkError(new Error("boom"), 1000)).toBe(false);
    expect(reloadOnceForChunkError(chunk, 1000)).toBe(true);
    expect(reloadOnceForChunkError(chunk, 2000)).toBe(false); // guarded: no reload loop
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
