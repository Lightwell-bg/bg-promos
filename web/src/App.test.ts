import { describe, expect, it } from "vitest";
import { redirectTarget } from "./App";

describe("redirectTarget", () => {
  it("invalid language prefix keeps the rest of the path", () => {
    expect(redirectTarget("/xx/catalog", "ru")).toBe("/ru/catalog");
    expect(redirectTarget("/xx/c/dairy_eggs", "bg")).toBe("/bg/c/dairy_eggs");
    expect(redirectTarget("/xx", "bg")).toBe("/bg");
    expect(redirectTarget("/xx/", "bg")).toBe("/bg");
  });
  it("missing prefix on a known page keeps the page", () => {
    expect(redirectTarget("/catalog", "bg")).toBe("/bg/catalog");
    expect(redirectTarget("/offer/abc", "ru")).toBe("/ru/offer/abc");
  });
  it("root and unknown single segments go to the language home", () => {
    expect(redirectTarget("/", "bg")).toBe("/bg");
    expect(redirectTarget("/whatever", "ru")).toBe("/ru");
  });
});
