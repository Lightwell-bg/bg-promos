import type { CardMode } from "../domain/filters";
import { formatEUR, priceModel, saleUnitOf, unitKey } from "../domain/price";
import type { Offer } from "../domain/types";
import { useT } from "../i18n/LangContext";
import styles from "./PriceBlock.module.css";

interface Props {
  offer: Offer;
  /** "full" adds the savings line (offer detail). */
  variant?: "compact" | "full";
  /** Catalog card filter: "without" shows the no-card condition as the main price. */
  card?: CardMode;
}

/** Formats the server-derived price data; never computes prices itself. */
export function PriceBlock({ offer, variant = "compact", card = "all" }: Props) {
  const t = useT();
  const m = priceModel(offer, card);
  if (m.mainCents == null) {
    return <p className={styles.muted}>{t("price.none")}</p>;
  }
  const multibuy = m.qty > 1;
  const unit = t(unitKey(saleUnitOf(offer)));
  return (
    <div className={`${styles.root} ${variant === "full" ? styles.full : ""}`}>
      {/* Hierarchy: big price + red discount badge, then condition chips and the struck price. */}
      <div className={styles.mainRow}>
        <span className={styles.amount}>
          {formatEUR(m.mainCents)}
          {multibuy && <span className={styles.qty}> {t("price.perQty", { n: m.qty })}</span>}
        </span>
        {m.discountPct != null && <span className={styles.discount}>-{m.discountPct}%</span>}
      </div>

      {(m.chips.length > 0 || m.struckCents != null) && (
        <div className={styles.chips}>
          {m.chips.map((c, i) => (
            <span key={i} className={styles.chip}>
              {t(c.key, c.params)}
            </span>
          ))}
          {m.struckCents != null && (
            <s className={styles.struck} aria-label={formatEUR(m.struckCents)}>
              {formatEUR(m.struckCents)}
            </s>
          )}
        </div>
      )}

      {multibuy && m.perItemCents != null && (
        <p className={styles.perItem}>
          {t("price.perItemBuy", { amount: formatEUR(m.perItemCents), unit, n: m.qty })}
        </p>
      )}

      {m.noCard?.state === "value" && (
        <p className={styles.noCard}>
          {m.noCard.qty > 1
            ? t("price.noCardQty", {
                amount: formatEUR(m.noCard.cents),
                n: m.noCard.qty,
                each: formatEUR(m.noCard.perItemCents),
                unit,
              })
            : t("price.noCard", { amount: formatEUR(m.noCard.cents), unit })}
        </p>
      )}
      {m.noCard?.state === "unknown" && <p className={styles.noCardUnknown}>{t("price.noCardUnknown")}</p>}

      {m.unitText && (
        <p className={styles.unit} title={m.unitComputed ? t("price.computed") : undefined}>
          {m.unitText}
        </p>
      )}

      {variant === "full" && m.savingsPerItemCents != null && m.savingsPerItemCents > 0 && (
        <p className={styles.savings}>{t("offer.savings", { amount: formatEUR(m.savingsPerItemCents), unit })}</p>
      )}
    </div>
  );
}
