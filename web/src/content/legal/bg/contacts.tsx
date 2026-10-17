import { useState } from "react";
import { ReportDialog } from "../../../components/ReportDialog";
import { Doc, Ext, LegalLink, Mail, OPERATOR, SITE_URL, UPDATED } from "../parts";
import styles from "../legal.module.css";

export default function ContactsBg() {
  const [reporting, setReporting] = useState(false);
  return (
    <Doc title="Контакти" updated={`Последна актуализация: ${UPDATED}`}>
      <p>
        Оператор на услугата: <strong>{OPERATOR}</strong>.
      </p>
      <ul>
        <li>
          Имейл: <Mail />
        </li>
        <li>
          Сайт: <Ext href={SITE_URL}>{SITE_URL}</Ext>
        </li>
      </ul>

      <h2>Грешка в цена или оферта?</h2>
      <p>Опишете проблемата във формата – съобщението стига до администратора.</p>
      <p>
        <button type="button" className={styles.actionBtn} onClick={() => setReporting(true)}>
          Форма за съобщаване за грешка
        </button>
      </p>

      <h2>Лични данни</h2>
      <p>
        За искания по GDPR (достъп, изтриване, възражение, оттегляне на съгласие) пишете на <Mail />. Подробности:{" "}
        <LegalLink lang="bg" page="privacy">
          политика за поверителност
        </LegalLink>
        .
      </p>
      {reporting && <ReportDialog offerId={null} onClose={() => setReporting(false)} />}
    </Doc>
  );
}
