import { useId, useRef } from "react";
import { useModal } from "../hooks/useModal";
import { useT } from "../i18n/LangContext";
import styles from "./Dialog.module.css";

interface Props {
  title: string;
  text: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}

/** In-app confirmation (never window.confirm: it is blocked or ugly in Telegram webviews). */
export function ConfirmDialog({ title, text, confirmLabel, onConfirm, onClose }: Props) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  useModal(ref, onClose);
  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        ref={ref}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <p className={styles.hint}>{text}</p>
        <div className={styles.actions}>
          <button type="button" data-autofocus className={styles.secondary} onClick={onClose}>
            {t("cart.cancel")}
          </button>
          <button type="button" className={styles.primary} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
