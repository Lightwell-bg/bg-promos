import type { Lang } from "../domain/types";
import bg from "./bg.json";
import ru from "./ru.json";

export const MESSAGES: Record<Lang, Record<string, string>> = { bg, ru };

export type TParams = Record<string, string | number>;
export type TFn = (key: string, params?: TParams) => string;

export function isLang(v: unknown): v is Lang {
  return v === "bg" || v === "ru";
}

/**
 * Stored choice wins; otherwise "bg" if any browser language starts with "bg";
 * otherwise "ru".
 */
export function detectLang(stored: string | null | undefined, languages: readonly string[]): Lang {
  if (isLang(stored)) return stored;
  if (languages.some((l) => l.toLowerCase().startsWith("bg"))) return "bg";
  return "ru";
}

export function translate(lang: Lang, key: string, params?: TParams): string {
  const template = MESSAGES[lang][key] ?? MESSAGES.bg[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in params ? String(params[name]) : m,
  );
}

export function makeT(lang: Lang): TFn {
  return (key, params) => translate(lang, key, params);
}
