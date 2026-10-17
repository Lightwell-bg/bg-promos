import { useRef, useState } from "react";
import {
  centsToEuroParam,
  DISC_OPTIONS,
  ENDS_OPTIONS,
  parseEuroToCents,
  type CardMode,
  type Filters,
  type WhenMode,
} from "../domain/filters";
import { CHAIN_IDS, CHAIN_NAMES, type Category, type ChainId } from "../domain/types";
import { useLang, useT } from "../i18n/LangContext";
import { useModal } from "../hooks/useModal";
import { CloseIcon } from "./Icons";
import dialog from "./Dialog.module.css";
import styles from "./FilterSheet.module.css";

interface Props {
  filters: Filters;
  categories: Category[];
  onApply: (f: Filters) => void;
  onClose: () => void;
  /** Category landing pages fix the category: no category group. */
  hideCategories?: boolean;
}

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

/** Bottom sheet with all filters; changes apply on "Show results". */
export function FilterSheet({ filters, categories, onApply, onClose, hideCategories }: Props) {
  const t = useT();
  const lang = useLang();
  const [draft, setDraft] = useState<Filters>(filters);
  const [pmin, setPmin] = useState(filters.pmin != null ? centsToEuroParam(filters.pmin) : "");
  const [pmax, setPmax] = useState(filters.pmax != null ? centsToEuroParam(filters.pmax) : "");

  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModal(dialogRef, onClose);

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setDraft((d) => ({ ...d, [k]: v }));

  function apply() {
    onApply({ ...draft, pmin: parseEuroToCents(pmin), pmax: parseEuroToCents(pmax) });
  }
  function reset() {
    setDraft({ ...draft, chains: [], cats: [], disc: 0, card: "all", when: "now", ends: 0 });
    setPmin("");
    setPmax("");
  }

  const radio = <T extends string | number>(
    name: string,
    value: T,
    current: T,
    label: string,
    onPick: (v: T) => void,
  ) => (
    <label className={`${styles.opt} ${current === value ? styles.optOn : ""}`} key={String(value)}>
      <input
        type="radio"
        name={name}
        checked={current === value}
        onChange={() => onPick(value)}
        className="sr-only"
      />
      {label}
    </label>
  );

  const cardModes: CardMode[] = ["all", "without", "only"];
  const whenModes: WhenMode[] = ["now", "upcoming", "all"];

  return (
    <div className={dialog.backdrop} onClick={onClose}>
      <div
        ref={dialogRef}
        className={dialog.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="filters-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.head}>
          <h2 id="filters-title" className={dialog.title}>
            {t("catalog.filters")}
          </h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label={t("common.close")}>
            <CloseIcon />
          </button>
        </div>

        <fieldset className={styles.group}>
          <legend>{t("filter.chains")}</legend>
          <div className={styles.row}>
            {CHAIN_IDS.map((c: ChainId) => (
              <label key={c} className={`${styles.opt} ${draft.chains.includes(c) ? styles.optOn : ""}`}>
                <input
                  type="checkbox"
                  checked={draft.chains.includes(c)}
                  onChange={() => set("chains", toggle(draft.chains, c))}
                  className="sr-only"
                />
                {CHAIN_NAMES[c]}
              </label>
            ))}
          </div>
        </fieldset>

        {!hideCategories && (
          <fieldset className={styles.group}>
            <legend>{t("filter.categories")}</legend>
            <div className={styles.row}>
              {categories.map((c) => (
                <label key={c.id} className={`${styles.opt} ${draft.cats.includes(c.id) ? styles.optOn : ""}`}>
                  <input
                    type="checkbox"
                    checked={draft.cats.includes(c.id)}
                    onChange={() => set("cats", toggle(draft.cats, c.id))}
                    className="sr-only"
                  />
                  {c.icon} {c[lang]}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <fieldset className={styles.group}>
          <legend>{t("filter.price")}</legend>
          <div className={styles.row}>
            <input
              className={styles.num}
              inputMode="decimal"
              placeholder={t("filter.from")}
              aria-label={t("filter.from")}
              value={pmin}
              onChange={(e) => setPmin(e.target.value)}
            />
            <span aria-hidden="true">–</span>
            <input
              className={styles.num}
              inputMode="decimal"
              placeholder={t("filter.to")}
              aria-label={t("filter.to")}
              value={pmax}
              onChange={(e) => setPmax(e.target.value)}
            />
          </div>
        </fieldset>

        <fieldset className={styles.group}>
          <legend>{t("filter.discount")}</legend>
          <div className={styles.row}>
            {DISC_OPTIONS.map((d) =>
              radio("disc", d, draft.disc, d === 0 ? t("filter.any") : `${d}%+`, (v) => set("disc", v)),
            )}
          </div>
        </fieldset>

        <fieldset className={styles.group}>
          <legend>{t("filter.card")}</legend>
          <div className={styles.row}>
            {cardModes.map((m) => radio("card", m, draft.card, t(`filter.card.${m}`), (v) => set("card", v)))}
          </div>
        </fieldset>

        <fieldset className={styles.group}>
          <legend>{t("filter.when")}</legend>
          <div className={styles.row}>
            {whenModes.map((m) => radio("when", m, draft.when, t(`filter.when.${m}`), (v) => set("when", v)))}
          </div>
        </fieldset>

        <fieldset className={styles.group}>
          <legend>{t("filter.ends")}</legend>
          <div className={styles.row}>
            {ENDS_OPTIONS.map((n) =>
              radio(
                "ends",
                n,
                draft.ends,
                n === 0 ? t("filter.ends.any") : t(n === 1 ? "filter.ends.day" : "filter.ends.days", { n }),
                (v) => set("ends", v),
              ),
            )}
          </div>
        </fieldset>

        <div className={dialog.actions}>
          <button type="button" className={dialog.secondary} onClick={reset}>
            {t("filter.reset")}
          </button>
          <button type="button" className={dialog.primary} onClick={apply}>
            {t("filter.apply")}
          </button>
        </div>
      </div>
    </div>
  );
}
