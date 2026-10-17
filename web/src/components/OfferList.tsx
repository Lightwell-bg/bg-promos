import { useEffect, useRef, useState } from "react";
import type { Category, Offer } from "../domain/types";
import { useT } from "../i18n/LangContext";
import { OfferCard } from "./OfferCard";
import styles from "./OfferList.module.css";

const PAGE = 40;

interface Props {
  offers: Offer[];
  categories: Category[];
  today: string;
}

/** Grid of cards rendered incrementally (40 at a time) as the user scrolls. */
export function OfferList({ offers, categories, today }: Props) {
  const t = useT();
  const [shown, setShown] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const catById = new Map(categories.map((c) => [c.id, c]));

  // A new result set starts from the top again.
  useEffect(() => setShown(PAGE), [offers]);

  const hasMore = shown < offers.length;
  const hasIO = typeof IntersectionObserver !== "undefined";
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || !hasIO) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setShown((n) => n + PAGE);
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, hasIO, shown]);

  return (
    <>
      <div className={styles.grid}>
        {offers.slice(0, shown).map((o) => (
          <OfferCard key={o.id} offer={o} category={catById.get(o.category)} today={today} />
        ))}
      </div>
      {hasMore && (
        <div ref={sentinel} className={styles.more}>
          {hasIO ? (
            <span>{t("catalog.loadingMore")}</span>
          ) : (
            <button type="button" className={styles.btn} onClick={() => setShown((n) => n + PAGE)}>
              {t("catalog.loadingMore")}
            </button>
          )}
        </div>
      )}
    </>
  );
}
