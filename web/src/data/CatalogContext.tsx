import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { todaySofia, status as offerStatus } from "../domain/dates";
import type { Catalog, Offer } from "../domain/types";
import { onForeground } from "../platform/lifecycle";
import { storage } from "../platform/storage";
import { API_BASE } from "./api";
import { CatalogStore, type CatalogState } from "./catalogStore";

const CatalogCtx = createContext<CatalogStore | null>(null);

export function CatalogProvider({ children, store }: { children: ReactNode; store?: CatalogStore }) {
  const [s] = useState(() => store ?? new CatalogStore({ storage, apiBase: API_BASE }));
  useEffect(() => {
    void s.init();
    return onForeground(() => void s.refresh());
  }, [s]);
  return <CatalogCtx.Provider value={s}>{children}</CatalogCtx.Provider>;
}

function useStore(): CatalogStore {
  const s = useContext(CatalogCtx);
  if (!s) throw new Error("CatalogProvider missing");
  return s;
}

export function useCatalogState(): CatalogState {
  const s = useStore();
  return useSyncExternalStore(s.subscribe, s.getSnapshot);
}

export function useRefreshCatalog(): () => void {
  const s = useStore();
  return () => void s.refresh({ force: true });
}

/** Current Sofia date, re-evaluated every minute so offers expire at midnight. */
export function useToday(): string {
  const [today, setToday] = useState(() => todaySofia());
  useEffect(() => {
    const id = setInterval(() => setToday(todaySofia()), 60_000);
    return () => clearInterval(id);
  }, []);
  return today;
}

export interface CatalogView {
  state: CatalogState;
  catalog: Catalog | null;
  today: string;
  /** Active + upcoming offers (ended ones are never included). */
  offers: Offer[];
}

export function useCatalog(): CatalogView {
  const state = useCatalogState();
  const today = useToday();
  const catalog = state.catalog;
  const offers = useMemo(
    () => (catalog ? catalog.offers.filter((o) => offerStatus(o, today) !== "ended") : []),
    [catalog, today],
  );
  return { state, catalog, today, offers };
}
