import { MAX_QTY } from "../domain/cart";
import { useT } from "../i18n/LangContext";
import { MinusIcon, PlusIcon } from "./Icons";
import styles from "./QtyStepper.module.css";

interface Props {
  qty: number;
  /** Called with the new quantity; 0 means "remove" (minus pressed at 1). */
  onChange: (qty: number) => void;
  /** Slightly narrower number cell (used on offer cards). */
  compact?: boolean;
}

/** "− 2 +" control; every button is a 44 px tap target. */
export function QtyStepper({ qty, onChange, compact }: Props) {
  const t = useT();
  return (
    <div className={`${styles.root} ${compact ? styles.compact : ""}`} role="group" aria-label={t("cart.qty")}>
      <button type="button" className={styles.btn} aria-label={t("cart.dec")} onClick={() => onChange(qty - 1)}>
        <MinusIcon />
      </button>
      <output className={styles.qty} aria-live="polite">
        {qty}
      </output>
      <button
        type="button"
        className={styles.btn}
        aria-label={t("cart.inc")}
        disabled={qty >= MAX_QTY}
        onClick={() => onChange(qty + 1)}
      >
        <PlusIcon />
      </button>
    </div>
  );
}
