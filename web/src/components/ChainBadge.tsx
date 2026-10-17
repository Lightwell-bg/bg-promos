import { CHAIN_NAMES, type ChainId } from "../domain/types";
import styles from "./ChainBadge.module.css";

/** Text badge in the chain's colours (no official logos). */
export function ChainBadge({ chain }: { chain: ChainId }) {
  return (
    <span className={`${styles.badge} ${styles[chain]}`}>
      {chain === "lidl" ? <span className={styles.lidlAccent}>{CHAIN_NAMES.lidl}</span> : CHAIN_NAMES[chain]}
    </span>
  );
}
