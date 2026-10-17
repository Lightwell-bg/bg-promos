import { Link } from "react-router-dom";
import { validityLabel } from "../domain/dates";
import type { CardMode } from "../domain/filters";
import type { Category, Offer } from "../domain/types";
import { useLang, useT } from "../i18n/LangContext";
import { ChainBadge } from "./ChainBadge";
import styles from "./OfferCard.module.css";
import { OfferImage } from "./OfferImage";
import { PriceBlock } from "./PriceBlock";

interface Props {
  offer: Offer;
  category?: Category;
  today: string;
  /** Fixed-width variant for horizontal rails. */
  rail?: boolean;
  /** Catalog card filter, forwarded to the price block. */
  card?: CardMode;
}

export function OfferCard({ offer, category, today, rail, card }: Props) {
  const t = useT();
  const lang = useLang();
  const v = validityLabel(offer, today);
  return (
    <article className={`${styles.card} ${styles[offer.chain]} ${rail ? styles.rail : ""}`}>
      <Link to={`/${lang}/offer/${offer.id}`} className={styles.link}>
        <OfferImage src={offer.image_url} alt="" icon={category?.icon ?? "🛒"} chain={offer.chain} />
        <div className={styles.body}>
          <ChainBadge chain={offer.chain} />
          <h3 className={styles.name}>{offer.name}</h3>
          <PriceBlock offer={offer} card={card} />
          <p className={`${styles.validity} ${v.key === "validity.lastDay" ? styles.lastDay : ""}`}>
            {t(v.key, v.params)}
          </p>
        </div>
      </Link>
    </article>
  );
}
