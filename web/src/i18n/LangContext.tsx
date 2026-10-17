import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Lang } from "../domain/types";
import { makeT, type TFn } from "./index";

const LangCtx = createContext<Lang>("bg");

export function LangProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  return <LangCtx.Provider value={lang}>{children}</LangCtx.Provider>;
}

export function useLang(): Lang {
  return useContext(LangCtx);
}

export function useT(): TFn {
  const lang = useLang();
  return useMemo(() => makeT(lang), [lang]);
}
