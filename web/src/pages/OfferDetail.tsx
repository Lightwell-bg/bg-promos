import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useCanGoBack } from "../hooks/useNavDepth";
import { CartButton } from "../components/CartButton";
import { ChainBadge } from "../components/ChainBadge";
import { EmptyState } from "../components/EmptyState";
import { DetailSkeleton } from "../components/Skeleton";
import { BackIcon, ExternalIcon, FlagIcon, ShareIcon } from "../components/Icons";
import { OfferImage } from "../components/OfferImage";
import { PriceBlock } from "../components/PriceBlock";
import { ReportDialog } from "../components/ReportDialog";
import { useCatalog } from "../data/CatalogContext";
import { validityLabel } from "../domain/dates";
import { conditionChips, formatEUR } from "../domain/price";
import { CHAIN_NAMES } from "../domain/types";
import { useLang, useT } from "../i18n/LangContext";
import { record, track } from "../platform/analytics";
import { setTitle } from "../platform/document";
import { currentUrl } from "../platform/env";
import { isSafeExternalUrl, openExternal } from "../platform/openExternal";
import { share } from "../platform/share";
import styles from "./OfferDetail.module.css";
import page from "./Page.module.css";

export function OfferDetail() {
  const { id } = useParams();
  const t = useT();
  const lang = useLang();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  // Direct entry (also after a language switch, which replaces the entry): go to the catalog.
  const goBack = () => (canGoBack() ? navigate(-1) : navigate(`/${lang}/catalog`));
  const { catalog, offers, today, state } = useCatalog();
  const [reporting, setReporting] = useState(false);
  const [note, setNote] = useState("");

  const offer = offers.find((o) => o.id === id);
  const offerId = offer?.id;
  const offerChain = offer?.chain;
  const offerCategory = offer?.category;
  const offerName = offer?.name;

  // Own <title>; never sends the product name to analytics.
  useEffect(() => {
    if (offerName) setTitle(`${offerName} | ${t("app.name")}`);
  }, [offerName, t]);
  useEffect(() => {
    if (!offerId) return;
    track("view_offer", { chain: offerChain ?? "", category: offerCategory ?? "" });
    // dedupeMs: StrictMode runs this effect twice in development; one view is one logical action.
    record("offer_view", { offer_id: offerId, chain: offerChain ?? "", category: offerCategory ?? "" }, { dedupeMs: 1500 });
  }, [offerId, offerChain, offerCategory]);

  if (!catalog) {
    if (state.status === "error") return <EmptyState icon="📡" text={t("banner.error")} />;
    return <DetailSkeleton />;
  }
  if (!offer) {
    return (
      <div>
        <EmptyState icon="🔎" text={t("offer.notFound")}>
          <Link to={`/${lang}/catalog`} className={page.primaryBtn}>
            {t("nav.catalog")}
          </Link>
        </EmptyState>
      </div>
    );
  }
  const category = catalog.categories.find((c) => c.id === offer.category);
  const v = validityLabel(offer, today);

  async function onShare() {
    if (!offer) return;
    const result = await share({ title: offer.name, url: currentUrl() });
    track("share", { chain: offer.chain });
    if (result === "copied") {
      setNote(t("offer.shareCopied"));
      setTimeout(() => setNote(""), 3000);
    }
  }

  return (
    <article>
      <button type="button" className={styles.back} onClick={goBack}>
        <BackIcon /> {t("common.back")}
      </button>

      <OfferImage src={offer.image_url} alt={offer.name} icon={category?.icon ?? "🛒"} chain={offer.chain} large />

      <div className={styles.head}>
        <ChainBadge chain={offer.chain} />
        <h1 className={styles.name}>{offer.name}</h1>
      </div>

      <PriceBlock offer={offer} variant="full" />
      <CartButton offer={offer} variant="detail" />

      <dl className={styles.facts}>
        {offer.brand && (
          <>
            <dt>{t("offer.brand")}</dt>
            <dd>{offer.brand}</dd>
          </>
        )}
        <dt>{t("offer.chain")}</dt>
        <dd>{CHAIN_NAMES[offer.chain]}</dd>
        {category && (
          <>
            <dt>{t("offer.category")}</dt>
            <dd>
              {category.icon} {category[lang]}
            </dd>
          </>
        )}
        {offer.unit_text && (
          <>
            <dt>{t("offer.pack")}</dt>
            <dd>{offer.unit_text}</dd>
          </>
        )}
        <dt>{t("offer.validity")}</dt>
        <dd>{t(v.key, v.params)}</dd>
      </dl>

      {offer.prices.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.h2}>{t("offer.conditions")}</h2>
          <ul className={styles.conditions}>
            {offer.prices.map((p, i) => (
              <li key={i}>
                <span className={styles.condChips}>
                  {conditionChips(p)
                    .map((c) => t(c.key, c.params))
                    .join(" · ")}
                </span>
                <strong>
                  {formatEUR(p.total_cents)}
                  {p.min_qty > 1 ? ` ${t("price.perQty", { n: p.min_qty })}` : ""}
                </strong>
                {p.text && <span className={styles.condText}>{p.text}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {offer.description && (
        <section className={styles.section}>
          <h2 className={styles.h2}>{t("offer.description")}</h2>
          <p className={styles.desc}>{offer.description}</p>
        </section>
      )}

      <div className={styles.actions}>
        {isSafeExternalUrl(offer.source_url) && (
          <button
            type="button"
            className={page.primaryBtn}
            onClick={() => {
              track("outbound_source_click", { chain: offer.chain, product: offer.source_is_product });
              openExternal(offer.source_url);
            }}
          >
            {offer.source_is_product ? t("offer.source") : t("offer.sourceChain")} <ExternalIcon />
          </button>
        )}
        <button type="button" className={page.secondaryBtn} onClick={onShare}>
          <ShareIcon /> {t("offer.share")}
        </button>
        <button type="button" className={page.secondaryBtn} onClick={() => setReporting(true)}>
          <FlagIcon /> {t("offer.report")}
        </button>
      </div>
      {note && (
        <p role="status" className={styles.note}>
          {note}
        </p>
      )}

      {reporting && <ReportDialog offerId={offer.id} onClose={() => setReporting(false)} />}
    </article>
  );
}
