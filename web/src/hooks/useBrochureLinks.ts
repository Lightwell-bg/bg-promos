import { useCatalogState } from "../data/CatalogContext";
import { useConfig } from "../data/ConfigContext";
import { CHAIN_IDS, type ChainId } from "../domain/types";
import { isSafeExternalUrl } from "../platform/openExternal";

/** Brochure URL per chain: /api/v1/config first, then the catalog chain block. */
export function useBrochureLinks(): { chain: ChainId; url: string }[] {
  const cfg = useConfig();
  const { catalog } = useCatalogState();
  const out: { chain: ChainId; url: string }[] = [];
  for (const chain of CHAIN_IDS) {
    const url = cfg.brochures[chain] ?? catalog?.chains[chain]?.brochure_url;
    if (isSafeExternalUrl(url)) out.push({ chain, url });
  }
  return out;
}
