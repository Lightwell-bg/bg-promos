import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { EmptyState } from "../components/EmptyState";
import { useCart } from "../data/CartContext";
import { useCatalogState, useRefreshCatalog } from "../data/CatalogContext";
import { decodeShare, shareFromHash, type SharedItem } from "../domain/carts";
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
  const location = useLocation();
  const routerHash = location.hash;
  const cart = useCart();
  const { catalog, status } = useCatalogState();
  const refresh = useRefreshCatalog();
  const done = useRef(false);
  // The payload is read once: items from the Telegram start parameter (router state) or the
  // fragment, which is removed from the address bar after the import.
  const value = useRef<string | SharedItem[] | null | undefined>(undefined);
  if (value.current === undefined) {
    const fromState = (location.state as { startItems?: SharedItem[] } | null)?.startItems;
    // Router location first (a redirect keeps the fragment there), then the address bar.
    value.current = Array.isArray(fromState) ? fromState : readShare(routerHash || locationHash());
  }

  useEffect(() => {
    setTitle(`${t("cart.title")} | ${t("app.name")}`);
  }, [t]);

  useEffect(() => {
    if (done.current) return;
    const v = value.current;
    const invalid = (Array.isArray(v) ? v : decodeShare(v)).length === 0;
    // Nothing to import: no need to wait for the catalog.
    if (!catalog && !invalid) return;
    done.current = true;
    void cart.importFromLink(value.current).then((result) => {
      // Items from the Telegram start parameter: the hash may hold Telegram's own launch data - keep it.
      if (!Array.isArray(v)) clearLocationHash();
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
