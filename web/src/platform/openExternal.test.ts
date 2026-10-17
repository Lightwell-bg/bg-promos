import { afterEach, describe, expect, it, vi } from "vitest";
import { isSafeExternalUrl, openExternal, setExternalOpener, webOpener } from "./openExternal";

afterEach(() => setExternalOpener(webOpener));

describe("openExternal", () => {
  it("allows only http and https", () => {
    expect(isSafeExternalUrl("https://example.com/a?b=1")).toBe(true);
    expect(isSafeExternalUrl("http://example.com")).toBe(true);
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "//evil.com", "/relative", "", "not a url"]) {
      expect(isSafeExternalUrl(bad)).toBe(false);
    }
    expect(isSafeExternalUrl(null)).toBe(false);
  });

  it("opens safe URLs and ignores unsafe ones", () => {
    const open = vi.fn();
    setExternalOpener({ open });
    openExternal("https://example.com/x");
    openExternal("javascript:alert(1)");
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("https://example.com/x");
  });
});
