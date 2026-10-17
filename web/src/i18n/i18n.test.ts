import { describe, expect, it } from "vitest";
import { detectLang, MESSAGES, translate } from "./index";

describe("detectLang", () => {
  it("stored choice wins", () => {
    expect(detectLang("ru", ["bg-BG"])).toBe("ru");
    expect(detectLang("bg", ["ru-RU"])).toBe("bg");
  });
  it("any browser language starting with bg gives bg", () => {
    expect(detectLang(null, ["en-US", "bg"])).toBe("bg");
    expect(detectLang(undefined, ["BG-bg"])).toBe("bg");
  });
  it("otherwise ru", () => {
    expect(detectLang(null, ["en-US", "de"])).toBe("ru");
    expect(detectLang(null, [])).toBe("ru");
  });
  it("ignores an invalid stored value", () => {
    expect(detectLang("de", ["bg"])).toBe("bg");
  });
});

describe("translate", () => {
  it("interpolates params", () => {
    expect(translate("bg", "validity.until", { date: "21.10" })).toBe("до 21.10");
    expect(translate("ru", "price.noCardQty", { amount: "3,78 €", n: 2, each: "1,89 €", unit: "шт." })).toBe(
      "Без карты: 3,78 € за 2 шт. (1,89 €/шт.)",
    );
    expect(translate("ru", "price.noCard", { amount: "1,89 €", unit: "шт." })).toBe("Без карты: 1,89 €/шт.");
    expect(translate("bg", "price.noCard", { amount: "1,89 €", unit: "кг" })).toBe("Без карта: 1,89 €/кг");
  });
  it("returns the key for unknown messages", () => {
    expect(translate("bg", "no.such.key")).toBe("no.such.key");
  });
  it("bg and ru have exactly the same keys", () => {
    expect(Object.keys(MESSAGES.ru).sort()).toEqual(Object.keys(MESSAGES.bg).sort());
  });
  it("mandatory condition labels", () => {
    expect(translate("bg", "cond.all")).toBe("За всички");
    expect(translate("ru", "cond.all")).toBe("Для всех");
    expect(translate("bg", "program.billa_app")).toBe("В BILLA App");
    expect(translate("ru", "program.lidl_plus")).toBe("С картой Lidl Plus");
  });
});
