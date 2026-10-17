import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { AppConfig } from "../domain/types";
import { prefs } from "../platform/prefs";
import { fetchConfig } from "./api";

export const FALLBACK_CONFIG: AppConfig = {
  ga4_id: null,
  contact_email: "info@centerai.eu",
  operator: "CenterAI",
  site_url: "",
  brochures: {},
  report_enabled: true,
};

const ConfigCtx = createContext<AppConfig>(FALLBACK_CONFIG);

/** Runtime config from /api/v1/config; the last good copy is kept in prefs. */
export function ConfigProvider({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<AppConfig>(() => prefs.get<AppConfig>("config", FALLBACK_CONFIG));
  useEffect(() => {
    let alive = true;
    fetchConfig()
      .then((c) => {
        if (!alive) return;
        prefs.set("config", c);
        setCfg(c);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return <ConfigCtx.Provider value={cfg}>{children}</ConfigCtx.Provider>;
}

export function useConfig(): AppConfig {
  return useContext(ConfigCtx);
}
