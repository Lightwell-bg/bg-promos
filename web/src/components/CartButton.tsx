import { Link } from "react-router-dom";
import { useCart } from "../data/CartContext";
import { saleUnitOf, unitKey } from "../domain/price";
import type { Offer } from "../domain/types";
import { useLang, useT } from "../i18n/LangContext";
import styles from "./CartButton.module.css";
import { PlusIcon } from "./Icons";
import { QtyStepper } from "./QtyStepper";
import { WeightStepper } from "./WeightStepper";

interface Props {
  offer: Offer;
  /** "card": compact control under an offer card; "detail": full-size on the offer page. */
  variant?: "card" | "detail";
}

/**
 * Add-to-cart button that turns into a quantity stepper once the offer is in the cart.
 * Always rendered outside any <a>, so it never triggers a card navigation.
 */
export function CartButton({ offer, variant = "card" }: Props) {
  const t = useT();
  const lang = useLang();
  const cart = useCart();
  const qty = cart.qtyOf(offer.id);
  const onChange = (q: number) => (q < 1 ? cart.remove(offer.id) : cart.setQty(offer.id, q));
  const unit = saleUnitOf(offer);
  const grams = cart.gramsOfOffer(offer.id);

  if (qty > 0) {
    return (
      <div className={`${styles.root} ${variant === "detail" ? styles.detail : ""}`}>
        {unit !== "piece" && grams > 0 ? (
          <WeightStepper
            grams={grams}
            onChange={(g) => cart.setGrams(offer.id, g)}
            compact={variant === "card"}
            unit={t(unitKey(unit))}
          />
        ) : (
          <QtyStepper qty={qty} onChange={onChange} compact={variant === "card"} />
        )}
        {variant === "detail" && (
          <Link to={`/${lang}/cart`} className={styles.open}>
            {t("cart.open")}
          </Link>
        )}
      </div>
    );
  }
  return (
    <div className={`${styles.root} ${variant === "detail" ? styles.detail : ""}`}>
      <button
        type="button"
        className={variant === "detail" ? styles.addWide : styles.add}
        aria-label={t("cart.add")}
        title={t("cart.add")}
        onClick={() => cart.add(offer)}
      >
        <PlusIcon />
        {variant === "detail" && <span>{t("cart.add")}</span>}
      </button>
    </div>
  );
}
