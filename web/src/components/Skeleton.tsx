import type { ReactNode } from "react";
import { useT } from "../i18n/LangContext";
import page from "../pages/Page.module.css";
import styles from "./Skeleton.module.css";

/** One placeholder card with the real card's proportions (1:1 image, text lines, price). */
export function CardSkeleton({ rail }: { rail?: boolean }) {
  return (
    <div className={`${styles.card} ${rail ? styles.rail : ""}`} aria-hidden="true">
      <div className={`${styles.shimmer} ${styles.image}`} />
      <div className={styles.body}>
        <div className={`${styles.shimmer} ${styles.badge}`} />
        <div className={`${styles.shimmer} ${styles.line}`} />
        <div className={`${styles.shimmer} ${styles.lineShort}`} />
        <div className={`${styles.shimmer} ${styles.price}`} />
      </div>
    </div>
  );
}

/** Loading state for list pages: a grid of card skeletons. */
export function GridSkeleton({ count = 6 }: { count?: number }) {
  const t = useT();
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{t("skeleton.loading")}</span>
      <div className={styles.grid}>
        {Array.from({ length: count }, (_, i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

function SkeletonRailSection({ children, seeAll = true }: { children: ReactNode; seeAll?: boolean }) {
  return (
    <section className={page.section}>
      <div className={page.sectionHead}>
        <div className={`${styles.shimmer} ${page.skelTitle}`} />
        {seeAll && <div className={`${styles.shimmer} ${page.skelSeeAll}`} />}
      </div>
      <div className={page.rail}>{children}</div>
    </section>
  );
}

const cardRail = () => Array.from({ length: 4 }, (_, i) => <CardSkeleton key={i} rail />);

/**
 * Loading state for the home page. Mirrors the real layout box by box (search, chain pills,
 * top rail, category row, two more rails) so the content does not jump when data arrives.
 */
export function HomeSkeleton() {
  const t = useT();
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{t("skeleton.loading")}</span>
      <div className={page.sticky}>
        <div className={`${styles.shimmer} ${page.skelSearch}`} />
      </div>
      <div className={page.chainPills}>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className={`${styles.shimmer} ${page.skelPill}`} />
        ))}
      </div>
      <SkeletonRailSection>{cardRail()}</SkeletonRailSection>
      <SkeletonRailSection seeAll={false}>
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className={`${styles.shimmer} ${page.skelCat}`} />
        ))}
      </SkeletonRailSection>
      <SkeletonRailSection>{cardRail()}</SkeletonRailSection>
      <SkeletonRailSection>{cardRail()}</SkeletonRailSection>
    </div>
  );
}

/** Loading state for the offer page. */
export function DetailSkeleton() {
  const t = useT();
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{t("skeleton.loading")}</span>
      <div className={`${styles.shimmer} ${styles.detailImage}`} />
      <div className={`${styles.shimmer} ${styles.heading}`} />
      <div className={`${styles.shimmer} ${styles.price}`} />
    </div>
  );
}
