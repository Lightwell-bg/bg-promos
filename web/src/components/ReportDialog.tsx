import { useRef, useState, type FormEvent } from "react";
import { postReport, type ReportOutcome } from "../data/api";
import { useConfig } from "../data/ConfigContext";
import { useLang, useT } from "../i18n/LangContext";
import { track } from "../platform/analytics";
import { currentPageUrl } from "../platform/env";
import { useModal } from "../hooks/useModal";
import styles from "./Dialog.module.css";

interface Props {
  offerId: string | null;
  onClose: () => void;
}

type Phase = "idle" | "sending" | ReportOutcome;

/** Error report form: honeypot field "website" is sent as `hp`; elapsed_ms = time form was open. */
export function ReportDialog({ offerId, onClose }: Props) {
  const t = useT();
  const lang = useLang();
  const cfg = useConfig();
  const [message, setMessage] = useState("");
  const [hp, setHp] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const openedAt = useRef(Date.now());
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModal(dialogRef, onClose);

  const len = message.trim().length;
  const valid = len >= 5 && len <= 1000;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || phase === "sending") return;
    setPhase("sending");
    const outcome = await postReport({
      message: message.trim(),
      offer_id: offerId,
      page_url: currentPageUrl().slice(0, 300),
      lang,
      hp,
      elapsed_ms: Date.now() - openedAt.current,
    });
    setPhase(outcome);
    if (outcome === "ok") track("report_submitted"); // no message text, no offer id
  }

  const resultText: Partial<Record<Phase, string>> = {
    ok: t("report.success"),
    rate_limited: t("report.tooMany"),
    unavailable: t("report.unavailable", { email: cfg.contact_email }),
    invalid: t("report.invalid"),
    error: t("report.error"),
  };
  const done = phase === "ok";

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="report-title" className={styles.title}>
          {t("report.title")}
        </h2>
        {offerId && <p className={styles.hint}>{t("report.about", { id: offerId })}</p>}
        {done ? (
          <p role="status" className={styles.ok}>
            {resultText.ok}
          </p>
        ) : (
          <form onSubmit={submit}>
            <textarea
              data-autofocus
              className={styles.textarea}
              rows={5}
              minLength={5}
              maxLength={1000}
              value={message}
              placeholder={t("report.placeholder")}
              aria-label={t("report.placeholder")}
              onChange={(e) => setMessage(e.target.value)}
            />
            {/* honeypot: invisible to people, bots fill it in */}
            <input
              type="text"
              name="website"
              value={hp}
              onChange={(e) => setHp(e.target.value)}
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              className={styles.honeypot}
            />
            <p className={styles.counter}>{len}/1000</p>
            {resultText[phase] && (
              <p role="alert" className={styles.error}>
                {resultText[phase]}
              </p>
            )}
            <div className={styles.actions}>
              <button type="button" className={styles.secondary} onClick={onClose}>
                {t("report.cancel")}
              </button>
              <button type="submit" className={styles.primary} disabled={!valid || phase === "sending"}>
                {t("report.send")}
              </button>
            </div>
          </form>
        )}
        {done && (
          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={onClose}>
              {t("common.close")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
