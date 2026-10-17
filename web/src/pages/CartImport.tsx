import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { EmptyState } from "../components/EmptyState";
import { useCart } from "../data/CartContext";
import { useCatalogState, useRefreshCatalog } from "../data/CatalogContext";
import { decodeShare, shareFromHash } from "../domain/carts";
import { useLang, useT } from "../i18n/LangContext";
import { clearLocationHash, locationHash } from "../platform/env";
import { setTitle } from "../platform/document";
import page from "./Page.module.css";

/** Safe decode of the share value from the hash (a malformed %-escape means "no value"). */
function readShare(hash: string): string | null {
  try {
    return shareFromHash(hash);
  } catch {
    return null;
  }
}

/**
 * /:lang/cart/import#c=...: waits for the catalog, imports the shared list exactly once,
 * removes the hash and goes to the cart with a one-time message.
 */
export function CartImport() {
  const t = useT();
  const lang = useLang();
  const navigate = useNavigate();
  const routerHash = useLocation().hash;
  const cart = useCart();
  const { catalog, status } = useCatalogState();
  const refresh = useRefreshCatalog();
  const done = useRef(false);
  // The fragment is read once: it is removed from the address bar after the import.
  const value = useRef<string | null | undefined>(undefined);
  // Router location first (a redirect keeps the fragment there), then the address bar.
  if (value.current === undefined) value.current = readShare(routerHash || locationHash());

  useEffect(() => {
    setTitle(`${t("cart.title")} | ${t("app.name")}`);
  }, [t]);

  useEffect(() => {
    if (done.current) return;
    const invalid = decodeShare(value.current).length === 0;
    // Nothing to import: no need to wait for the catalog.
    if (!catalog && !invalid) return;
    done.current = true;
    void cart.importFromLink(value.current).then((result) => {
      clearLocationHash();
      navigate(`/${lang}/cart`, { replace: true, state: { importNote: { mode: result.mode, missing: result.missing } } });
    });
  }, [catalog, cart, lang, navigate]);

  if (!catalog && (status === "offline" || status === "error")) {
    return (
      <EmptyState icon="📡" text={t("cart.import.offline")}>
        <button type="button" className={page.primaryBtn} onClick={refresh}>
          {t("common.retry")}
        </button>
      </EmptyState>
    );
  }
  return (
    <p role="status" className={page.subtitle}>
      {t("cart.import.loading")}
    </p>
  );
}
