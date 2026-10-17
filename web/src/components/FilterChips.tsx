import { DEFAULT_FILTERS, type Filters } from "../domain/filters";
import { formatEUR } from "../domain/price";
import { CHAIN_NAMES, type Category } from "../domain/types";
import { useLang, useT } from "../i18n/LangContext";
import { CloseIcon } from "./Icons";
import styles from "./FilterChips.module.css";

interface Props {
  filters: Filters;
  categories: Category[];
  onChange: (f: Filters) => void;
}

/** Active filters as removable chips plus a "clear all" button. */
export function FilterChips({ filters: f, categories, onChange }: Props) {
  const t = useT();
  const lang = useLang();
  const chips: { key: string; label: string; remove: Filters }[] = [];

  if (f.q) chips.push({ key: "q", label: t("chip.query", { q: f.q }), remove: { ...f, q: "" } });
  for (const c of f.chains) {
    chips.push({ key: `chain-${c}`, label: CHAIN_NAMES[c], remove: { ...f, chains: f.chains.filter((x) => x !== c) } });
  }
  for (const id of f.cats) {
    const cat = categories.find((c) => c.id === id);
    chips.push({
      key: `cat-${id}`,
      label: cat ? `${cat.icon} ${cat[lang]}` : id,
      remove: { ...f, cats: f.cats.filter((x) => x !== id) },
    });
  }
  if (f.pmin != null || f.pmax != null) {
    const label =
      f.pmin != null && f.pmax != null
        ? t("chip.price", { from: formatEUR(f.pmin), to: formatEUR(f.pmax) })
        : f.pmin != null
          ? t("chip.priceFrom", { from: formatEUR(f.pmin) })
          : t("chip.priceTo", { to: formatEUR(f.pmax as number) });
    chips.push({ key: "price", label, remove: { ...f, pmin: null, pmax: null } });
  }
  if (f.disc) chips.push({ key: "disc", label: t("chip.disc", { n: f.disc }), remove: { ...f, disc: 0 } });
  if (f.card !== "all") {
    chips.push({
      key: "card",
      label: t(f.card === "only" ? "chip.cardOnly" : "chip.cardWithout"),
      remove: { ...f, card: "all" },
    });
  }
  if (f.when !== "now") {
    chips.push({
      key: "when",
      label: t(f.when === "upcoming" ? "chip.whenUpcoming" : "chip.whenAll"),
      remove: { ...f, when: "now" },
    });
  }
  if (f.ends) chips.push({ key: "ends", label: t("chip.ends", { n: f.ends }), remove: { ...f, ends: 0 } });

  if (!chips.length) return null;
  return (
    <div className={styles.row}>
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          className={styles.chip}
          onClick={() => onChange(c.remove)}
          aria-label={t("chip.remove", { name: c.label })}
        >
          {c.label}
          <CloseIcon />
        </button>
      ))}
      <button
        type="button"
        className={styles.clear}
        onClick={() => onChange({ ...DEFAULT_FILTERS, sort: f.sort })}
      >
        {t("catalog.clearAll")}
      </button>
    </div>
  );
}
