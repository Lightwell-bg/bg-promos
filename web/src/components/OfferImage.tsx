import { useEffect, useState } from "react";
import type { ChainId } from "../domain/types";
import styles from "./OfferImage.module.css";

interface Props {
  src: string | null;
  alt: string;
  icon: string;
  chain: ChainId;
  large?: boolean;
}

/** Offer photo; falls back to a tinted placeholder with the category emoji. */
export function OfferImage({ src, alt, icon, chain, large }: Props) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const cls = `${styles.box} ${large ? styles.large : ""}`;
  if (!src || failed) {
    return (
      <div className={`${cls} ${styles.placeholder} ${styles[chain]}`} role="img" aria-label={alt}>
        <span className={styles.emoji} aria-hidden="true">
          {icon}
        </span>
      </div>
    );
  }
  return (
    <div className={cls}>
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
