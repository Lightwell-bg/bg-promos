import { useState } from "react";
import { ReportDialog } from "../../../components/ReportDialog";
import { Doc, Ext, LegalLink, Mail, OPERATOR, SITE_URL, UPDATED } from "../parts";
import styles from "../legal.module.css";

export default function ContactsRu() {
  const [reporting, setReporting] = useState(false);
  return (
    <Doc title="Контакты" updated={`Последнее обновление: ${UPDATED}`}>
      <p>
        Оператор сервиса: <strong>{OPERATOR}</strong>.
      </p>
      <ul>
        <li>
          Email: <Mail />
        </li>
        <li>
          Сайт: <Ext href={SITE_URL}>{SITE_URL}</Ext>
        </li>
      </ul>

      <h2>Ошибка в цене или акции?</h2>
      <p>Опишите проблему в форме — сообщение попадёт к администратору.</p>
      <p>
        <button type="button" className={styles.actionBtn} onClick={() => setReporting(true)}>
          Форма сообщения об ошибке
        </button>
      </p>

      <h2>Персональные данные</h2>
      <p>
        По запросам GDPR (доступ, удаление, возражение, отзыв согласия) пишите на <Mail />. Подробнее:{" "}
        <LegalLink lang="ru" page="privacy">
          политика конфиденциальности
        </LegalLink>
        .
      </p>
      {reporting && <ReportDialog offerId={null} onClose={() => setReporting(false)} />}
    </Doc>
  );
}
