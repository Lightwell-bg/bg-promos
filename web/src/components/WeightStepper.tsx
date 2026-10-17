import { WEIGHT_MAX, WEIGHT_STEP } from "../domain/cart";
import { formatWeight } from "../domain/weight";
import { useT } from "../i18n/LangContext";
import { MinusIcon, PlusIcon } from "./Icons";
import styles from "./QtyStepper.module.css";

interface Props {
  grams: number;
  /** Called with the new grams; a value below the minimum means "remove". */
  onChange: (grams: number) => void;
  /** Localized short unit ("кг" / "л"). */
  unit: string;
  compact?: boolean;
}

/** "− 0,5 кг +" control, steps of 100 g; every button is a 44 px tap target. */
export function WeightStepper({ grams, onChange, unit, compact }: Props) {
  const t = useT();
  return (
    <div className={`${styles.root} ${compact ? styles.compact : ""}`} role="group" aria-label={t("cart.weight")}>
      <button
        type="button"
        className={styles.btn}
        aria-label={t("cart.weightDec")}
        onClick={() => onChange(grams - WEIGHT_STEP)}
      >
        <MinusIcon />
      </button>
      <output className={`${styles.qty} ${styles.weight}`} aria-live="polite">
        {formatWeight(grams, unit)}
      </output>
      <button
        type="button"
        className={styles.btn}
        aria-label={t("cart.weightInc")}
        disabled={grams >= WEIGHT_MAX}
        onClick={() => onChange(grams + WEIGHT_STEP)}
      >
        <PlusIcon />
      </button>
    </div>
  );
}
