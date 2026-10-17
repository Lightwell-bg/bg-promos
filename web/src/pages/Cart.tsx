import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChainBadge } from "../components/ChainBadge";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState } from "../components/EmptyState";
import { TrashIcon } from "../components/Icons";
import { OfferImage } from "../components/OfferImage";
import { QtyStepper } from "../components/QtyStepper";
import { useCart } from "../data/CartContext";
import { useCatalog } from "../data/CatalogContext";
import { hasCard } from "../domain/cart";
import type { ChainGroup, ReconciledLine } from "../domain/cart";
import { conditionChips, formatEUR, priceModel } from "../domain/price";
import { CHAIN_NAMES, type ChainId, type Offer } from "../domain/types";
import { useLang, useT } from "../i18n/LangContext";
import { setTitle } from "../platform/document";
import styles from "./Cart.module.css";
import page from "./Page.module.css";

/** "2026-10-19" -> "19.10". */
function shortDate(iso: string | null): string {
  if (!iso) return "";
  const [, m, d] = iso.split("-");
  return `${d}.${m}`;
}

type Confirm = { kind: "all" } | { kind: "chain"; chain: ChainId } | null;

export function Cart() {
  const t = useT();
  const lang = useLang();
  const cart = useCart();
  const { catalog } = useCatalog();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const { summary } = cart;

  useEffect(() => {
    setTitle(`${t("cart.title")} | ${t("app.name")}`);
  }, [t]);

  const icons = new Map((catalog?.categories ?? []).map((c) => [c.id, c.icon]));
  const onQty = (id: string, q: number) => (q < 1 ? cart.remove(id) : cart.setQty(id, q));

  function replacementPrice(o: Offer): string {
    const m = priceModel(o);
    if (m.mainCents == null) return t("price.none");
    return m.qty > 1 ? `${formatEUR(m.mainCents)} ${t("price.perQty", { n: m.qty })}` : formatEUR(m.mainCents);
  }

  function lineView(r: ReconciledLine) {
    const { line, price } = r;
    const total = price.totalCents;
    const ended = r.status === "ended";
    const chip = price.condition
      ? conditionChips(price.condition)
          .map((c) => t(c.key, c.params))
          .join(" · ")
      : total !== null
        ? t("cond.regular")
        : null;
    const approx = r.counted && price.approximate;
    const perItem =
      line.qty > 1 && total !== null
        ? `${approx || total % line.qty !== 0 ? "≈ " : ""}${t("cart.perItem", { amount: formatEUR(Math.round(total / line.qty)) })}`
        : null;
    return (
      <li key={line.offerId} className={`${styles.line} ${ended ? styles.ended : ""}`}>
        <div className={styles.thumb}>
          <OfferImage src={line.imageUrl} alt="" icon={icons.get(line.category) ?? "🛒"} chain={line.chain} />
        </div>
        <div className={styles.lineBody}>
          <div className={styles.lineHead}>
            {r.offer ? (
              <Link to={`/${lang}/offer/${r.offer.id}`} className={styles.name}>
                {line.name}
              </Link>
            ) : (
              <span className={styles.name}>{line.name}</span>
            )}
            <button
              type="button"
              className={styles.iconBtn}
              aria-label={t("cart.remove")}
              title={t("cart.remove")}
              onClick={() => cart.remove(line.offerId)}
            >
              <TrashIcon />
            </button>
          </div>
          {line.unitText && <p className={styles.unit}>{line.unitText}</p>}
          {chip && <span className={styles.chip}>{chip}</span>}

          <div className={styles.lineFoot}>
            <QtyStepper qty={line.qty} onChange={(q) => onQty(line.offerId, q)} compact />
            <div className={styles.amounts}>
              {total !== null ? (
                <strong className={`${styles.total} ${ended ? styles.struck : ""}`} data-testid="line-total">
                  {approx ? "≈ " : ""}
                  {formatEUR(total)}
                </strong>
              ) : (
                <span className={styles.noPrice}>{t("cart.noPrice")}</span>
              )}
              {perItem && <span className={styles.perItem}>{perItem}</span>}
            </div>
          </div>

          {r.priceChanged && r.offer && (
            <div className={`${styles.notice} ${styles.warn}`}>
              <span>
                {t("cart.priceChanged", {
                  was: r.previousTotalCents !== null ? formatEUR(r.previousTotalCents) : "—",
                  now: total !== null ? formatEUR(total) : "—",
                })}
              </span>
              <button type="button" className={styles.noticeBtn} onClick={() => cart.acceptPrice(r.offer as Offer)}>
                {t("cart.ok")}
              </button>
            </div>
          )}
          {r.status === "upcoming" && (
            <div className={`${styles.notice} ${styles.info}`}>
              {t("cart.upcoming", { date: shortDate(r.offer?.valid_from ?? null) })}
            </div>
          )}
          {ended && (
            <div className={`${styles.notice} ${styles.bad}`}>
              <span>{t("cart.ended")}</span>
            </div>
          )}
          {ended && r.replacement && (
            <div className={`${styles.notice} ${styles.info}`}>
              <span>{t("cart.replacement", { price: replacementPrice(r.replacement) })}</span>
              <button
                type="button"
                className={styles.noticeBtn}
                onClick={() => cart.replace(line.offerId, r.replacement as Offer)}
              >
                {t("cart.replace")}
              </button>
            </div>
          )}
          {r.status === "unknown" && <div className={`${styles.notice} ${styles.info}`}>{t("cart.unknown")}</div>}
          {approx && <div className={`${styles.notice} ${styles.info}`}>{t("cart.approxNote")}</div>}
          {!ended && price.addForDeal && (
            <div className={`${styles.notice} ${styles.hint}`}>
              {t("cart.addForDeal", { add: price.addForDeal.add, min: price.addForDeal.minQty })}
            </div>
          )}
          {price.cardOnly && total === null && (
            <div className={`${styles.notice} ${styles.warn}`}>{t("cart.cardOnly")}</div>
          )}
        </div>
      </li>
    );
  }

  function groupView(g: ChainGroup) {
    const program = t(`cart.program.${g.chain}`);
    const has = hasCard(cart.state.cards, g.chain);
    return (
      <section key={g.chain} className={`${styles.group} ${styles[g.chain]}`} aria-label={CHAIN_NAMES[g.chain]}>
        <div className={styles.groupHead}>
          <ChainBadge chain={g.chain} />
          <button type="button" className={styles.linkBtn} onClick={() => setConfirm({ kind: "chain", chain: g.chain })}>
            {t("cart.clearChain")}
          </button>
        </div>
        <label className={styles.cardToggle}>
          <input
            type="checkbox"
            checked={has}
            onChange={(e) => cart.setCard(g.chain, e.target.checked)}
          />
          <span>{t("cart.haveCard", { program })}</span>
        </label>
        <ul className={styles.lines}>{g.lines.map(lineView)}</ul>
        <div className={styles.subtotal}>
          <span>{t("cart.subtotal")}</span>
          <strong data-testid={`subtotal-${g.chain}`}>
            {g.approximate ? "≈ " : ""}
            {formatEUR(g.subtotalCents)}
          </strong>
        </div>
      </section>
    );
  }

  if (summary.groups.length === 0) {
    return (
      <div>
        <h1 className={page.title}>{t("cart.title")}</h1>
        <EmptyState icon="🛒" text={t("cart.empty")}>
          <p className={styles.emptyHint}>{t("cart.emptyHint")}</p>
          <Link to={`/${lang}/catalog`} className={page.primaryBtn}>
            {t("nav.catalog")}
          </Link>
        </EmptyState>
      </div>
    );
  }

  const confirmChain = confirm?.kind === "chain" ? confirm.chain : null;
  const usesCard = summary.groups.some((g) =>
    g.lines.some((l) => l.counted && l.price.totalCents !== null && l.price.condition?.program),
  );
  return (
    <div>
      <div className={styles.head}>
        <div>
          <h1 className={page.title}>{t("cart.title")}</h1>
          <p className={styles.count}>{t("cart.itemsCount", { n: cart.count })}</p>
        </div>
        <button type="button" className={page.secondaryBtn} onClick={() => setConfirm({ kind: "all" })}>
          {t("cart.clear")}
        </button>
      </div>

      {summary.groups.map(groupView)}

      <div className={styles.summary} aria-live="polite">
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>
            {t("cart.total")} · {t("cart.itemsInTotal", { n: summary.items })}
          </span>
          <strong className={styles.summaryTotal} data-testid="grand-total">
            {summary.approximate ? "≈ " : ""}
            {formatEUR(summary.totalCents)}
          </strong>
        </div>
        {summary.excluded > 0 && <p className={styles.excluded}>{t("cart.excluded", { n: summary.excluded })}</p>}
        {usesCard && <p className={styles.disclaimer}>{t("cart.cardPrices")}</p>}
        <p className={styles.disclaimer}>{t("cart.disclaimer")}</p>
      </div>

      {confirm?.kind === "all" && (
        <ConfirmDialog
          title={t("cart.clearTitle")}
          text={t("cart.clearText")}
          confirmLabel={t("cart.confirm")}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            cart.clear();
            setConfirm(null);
          }}
        />
      )}
      {confirmChain && (
        <ConfirmDialog
          title={t("cart.clearChainTitle", { chain: CHAIN_NAMES[confirmChain] })}
          text={t("cart.clearChainText")}
          confirmLabel={t("cart.confirm")}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            cart.clearChain(confirmChain);
            setConfirm(null);
          }}
        />
      )}
    </div>
  );
}
