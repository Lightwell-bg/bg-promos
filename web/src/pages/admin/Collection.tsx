import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import {
  AdminAuthError,
  getCollection,
  requestRun,
  resetSchedule,
  saveSchedule,
  type ChainCollection,
  type ChainSchedule,
  type CollectionData,
  type CollectionDays,
  type ScheduleOutcome,
} from "../../data/adminApi";
import styles from "../Admin.module.css";
import { Sparkline } from "./Charts";
import { fmtDuration, fmtHM, fmtSofia } from "./adminUtils";

/** "Сбор данных" tab: per-chain run statistics, schedule editor, "collect now" and the recent runs table. */

export const MAX_SLOTS = 24;
const SLOT_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAYS: CollectionDays[] = [7, 30, 90];

const CHAIN_NAMES: Record<string, string> = { lidl: "Lidl", kaufland: "Kaufland", billa: "BILLA" };
const STATUS_LABEL: Record<string, string> = {
  ok: "успешно",
  suspicious: "подозрительный",
  failed: "ошибка",
  running: "выполняется",
  interrupted: "прерван",
};
const STALE_MSG = "Расписание изменили в другом окне — данные обновлены";

const chainName = (c: string) => CHAIN_NAMES[c] ?? c;
const statusLabel = (s: string | null) => (s ? (STATUS_LABEL[s] ?? s) : "—");

/** Client-side check of a schedule draft; returns an error text or null. Mirrors the backend rules. */
export function validateSlots(enabled: boolean, slots: string[]): string | null {
  if (slots.length > MAX_SLOTS) return `Не больше ${MAX_SLOTS} времён в сутки`;
  if (slots.some((s) => !SLOT_RE.test(s))) return "Укажите время в формате ЧЧ:ММ в каждом поле";
  if (new Set(slots).size !== slots.length) return "Время запуска повторяется — уберите дубликаты";
  if (enabled && slots.length === 0) return "Добавьте хотя бы одно время запуска";
  return null;
}

function Badge({ status }: { status: string }) {
  const cls =
    status === "ok" ? styles.badgeOk : status === "running" ? styles.badgeRun : status === "failed" ? styles.badgeBad : styles.badgeWarn;
  return <span className={`${styles.badge} ${cls}`}>{statusLabel(status)}</span>;
}

type Msg = { kind: "error" | "info"; text: string } | null;

function ScheduleEditor({
  schedule,
  busy,
  onSave,
  onReset,
}: {
  schedule: ChainSchedule;
  busy: boolean;
  onSave: (enabled: boolean, slots: string[]) => void;
  onReset: () => void;
}) {
  // The parent keys this component by revision, so a reload with a new revision resets the draft.
  const [enabled, setEnabled] = useState(schedule.enabled);
  const [slots, setSlots] = useState<string[]>(schedule.slots);
  const [showErr, setShowErr] = useState(false);
  const error = validateSlots(enabled, slots);

  function addSlot() {
    const free = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`).find((s) => !slots.includes(s));
    setSlots([...slots, free ?? "00:00"]);
  }

  function submit() {
    if (busy) return;
    setShowErr(true);
    if (validateSlots(enabled, slots)) return;
    onSave(enabled, slots);
  }

  return (
    <fieldset className={styles.schedule} disabled={busy}>
      <legend>Расписание</legend>
      <label className={styles.check}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>Сбор по расписанию</span>
      </label>
      <ul className={styles.slots}>
        {slots.map((s, i) => (
          <li key={i}>
            <input
              type="time"
              step={60}
              value={s}
              aria-label={`Время ${i + 1}`}
              onChange={(e) => setSlots(slots.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <button
              type="button"
              className={styles.chip}
              aria-label={`Удалить время ${i + 1}`}
              onClick={() => setSlots(slots.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className={styles.chip} onClick={addSlot} disabled={slots.length >= MAX_SLOTS}>
        Добавить время
      </button>
      <p className={styles.note}>Время по Софии (Europe/Sofia). Не больше {MAX_SLOTS} времён в сутки.</p>
      {showErr && error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <p className={styles.note}>
        {schedule.source === "admin" ? `изменено в админке (${fmtSofia(schedule.updatedAt)})` : "из config.ini"}
      </p>
      <div className={styles.actionsRow}>
        <button type="button" className={styles.primary} onClick={submit} disabled={busy}>
          Сохранить
        </button>
        {schedule.source === "admin" && (
          <button type="button" className={styles.chip} onClick={onReset} disabled={busy}>
            Сбросить к config.ini
          </button>
        )}
      </div>
    </fieldset>
  );
}

function ChainCard({
  c,
  reload,
  onAuthLost,
}: {
  c: ChainCollection;
  reload: () => Promise<void>;
  onAuthLost: () => void;
}) {
  const name = chainName(c.chain);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [confirming, setConfirming] = useState(false);

  /** One request at a time per card (ref guards double clicks within the same tick). */
  async function run(fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof AdminAuthError) onAuthLost();
      else setMsg({ kind: "error", text: "Не удалось выполнить запрос. Проверьте соединение." });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function handleOutcome(o: ScheduleOutcome, okText: string) {
    if (o.kind === "ok") setMsg({ kind: "info", text: okText });
    else if (o.kind === "stale") setMsg({ kind: "error", text: STALE_MSG });
    else setMsg({ kind: "error", text: o.detail });
    if (o.kind !== "invalid") await reload();
  }

  const save = (enabled: boolean, slots: string[]) =>
    run(async () => handleOutcome(await saveSchedule(c.chain, { enabled, slots, revision: c.schedule.revision }), "Расписание сохранено"));

  const reset = () =>
    run(async () => {
      setConfirming(false);
      await handleOutcome(await resetSchedule(c.chain, c.schedule.revision), "Расписание сброшено к config.ini");
    });

  const collectNow = () =>
    run(async () => {
      await requestRun(c.chain);
      await reload();
    });

  if (!c.configEnabled) {
    return (
      <section className={`${styles.panel} ${styles.disabledCard}`} aria-label={name}>
        <h2>{name}</h2>
        <p>отключён в config.ini</p>
      </section>
    );
  }

  const last = c.lastRun;
  const p = c.period;
  const offerValues = c.series.map((s) => s.offersCount).filter((v): v is number => v !== null);
  const pending = c.pendingRequest;
  const lr = c.lastRequest;

  return (
    <section className={styles.panel} aria-label={name}>
      <div className={styles.cardHead}>
        <h2>{name}</h2>
        {last && <Badge status={last.status} />}
      </div>

      {last ? (
        <dl className={styles.profile}>
          <dt>Последний запуск</dt>
          <dd>
            {fmtSofia(last.startedAt)} · {last.scheduled ? "по расписанию" : "вручную"}
          </dd>
          <dt>Предложений</dt>
          <dd>
            {last.offersCount ?? "—"} (активных: {last.activeCount ?? "—"})
          </dd>
          <dt>Длительность</dt>
          <dd>{fmtDuration(last.durationS)}</dd>
        </dl>
      ) : (
        <p className={styles.note}>Запусков ещё не было</p>
      )}
      <p>
        Последний успешный сбор: {fmtSofia(c.lastOkAt)}
        {c.stale && <span className={styles.staleWarn}> устарело</span>}
      </p>
      {last?.error && <p className={styles.runError}>{last.error}</p>}

      <h3 className={styles.sub}>За период</h3>
      <dl className={styles.profile}>
        <dt>Запусков</dt>
        <dd>
          {p.runs} (успешно {p.ok}, подозрительных {p.suspicious}, с ошибкой {p.failed})
        </dd>
        <dt>Успешных</dt>
        <dd>{p.successRate === null ? "—" : `${Math.round(p.successRate * 100)}%`}</dd>
        <dt>Среднее время</dt>
        <dd>{fmtDuration(p.avgDurationS)}</dd>
        <dt>Среднее число предложений</dt>
        <dd>{p.avgOffers === null ? "—" : Math.round(p.avgOffers)}</dd>
      </dl>
      {offerValues.length >= 2 && (
        <div>
          <p className={styles.note}>Предложений по запускам</p>
          <Sparkline values={offerValues} />
        </div>
      )}

      <p>
        Следующий сбор:{" "}
        {c.nextSlotAt ? fmtSofia(c.nextSlotAt) : c.schedule.enabled ? "—" : "расписание выключено"}
      </p>
      <p className={styles.note}>сбор начинается при ближайшем запуске cron (каждый час в :00) после этого времени</p>

      <div className={styles.actionsRow}>
        <button type="button" className={styles.primary} onClick={() => void collectNow()} disabled={busy || !!pending}>
          Собрать сейчас
        </button>
      </div>
      {pending && (
        <p role="status" className={styles.note}>
          В очереди с {fmtHM(pending.requestedAt)} — запустится при ближайшем часовом запуске
        </p>
      )}
      {lr && !pending && (
        <p className={styles.note}>
          Последний ручной запуск: {statusLabel(lr.status)} ({fmtSofia(lr.finishedAt ?? lr.claimedAt ?? lr.requestedAt)})
        </p>
      )}

      <ScheduleEditor
        key={c.schedule.revision}
        schedule={c.schedule}
        busy={busy}
        onSave={(e, s) => void save(e, s)}
        onReset={() => setConfirming(true)}
      />
      {msg && (
        <p role={msg.kind === "error" ? "alert" : "status"} className={msg.kind === "error" ? styles.error : styles.note}>
          {msg.text}
        </p>
      )}
      {confirming && (
        <ConfirmDialog
          title="Сбросить расписание?"
          text={`Расписание ${name} снова будет браться из config.ini. Изменения из админки будут потеряны.`}
          confirmLabel="Сбросить"
          onClose={() => setConfirming(false)}
          onConfirm={() => void reset()}
        />
      )}
    </section>
  );
}

function truncate(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function Collection({ onAuthLost }: { onAuthLost: () => void }) {
  const [days, setDays] = useState<CollectionDays>(7);
  const [chain, setChain] = useState("");
  const [data, setData] = useState<CollectionData | null>(null);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  // Always the latest filter: a refresh triggered by a mutation must not fetch an older period/chain.
  const query = useRef({ days, chain });
  query.current = { days, chain };

  const load = useCallback(async () => {
    const my = ++seq.current;
    const { days: d0, chain: c0 } = query.current;
    try {
      const d = await getCollection(d0, c0);
      if (my === seq.current) {
        setData(d);
        setFailed(false);
      }
    } catch (e) {
      if (e instanceof AdminAuthError) onAuthLost();
      else if (my === seq.current) setFailed(true);
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load, days, chain]);

  return (
    <>
      <section className={styles.panel} aria-label="Период сбора">
        <div className={styles.presets} role="group" aria-label="Период">
          {DAYS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={days === d}
              className={`${styles.chip} ${days === d ? styles.chipOn : ""}`}
              onClick={() => setDays(d)}
            >
              {d} дней
            </button>
          ))}
        </div>
      </section>

      {failed && (
        <p role="alert" className={styles.error}>
          Не удалось загрузить данные о сборе
        </p>
      )}
      {!data && !failed && <p role="status">Загрузка…</p>}

      {data?.chains.map((c) => (
        <ChainCard key={c.chain} c={c} reload={load} onAuthLost={onAuthLost} />
      ))}

      {data && (
        <section className={styles.panel} aria-label="Последние запуски">
          <h2>Последние запуски</h2>
          <label className={styles.field}>
            <span>Сеть</span>
            <select value={chain} onChange={(e) => setChain(e.target.value)}>
              <option value="">Все</option>
              {data.chains.map((c) => (
                <option key={c.chain} value={c.chain}>
                  {chainName(c.chain)}
                </option>
              ))}
            </select>
          </label>
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Время</th>
                  <th>Сеть</th>
                  <th>Запуск</th>
                  <th>Статус</th>
                  <th>Предложений</th>
                  <th>Активных</th>
                  <th>Длительность</th>
                  <th>Ошибка</th>
                </tr>
              </thead>
              <tbody>
                {data.recentRuns.length ? (
                  data.recentRuns.map((r) => (
                    <tr key={r.id}>
                      <td>{fmtSofia(r.startedAt)}</td>
                      <td>{chainName(r.chain)}</td>
                      <td>{r.scheduled ? "по расписанию" : "вручную"}</td>
                      <td>
                        <Badge status={r.status} />
                      </td>
                      <td>{r.offersCount ?? "—"}</td>
                      <td>{r.activeCount ?? "—"}</td>
                      <td>{fmtDuration(r.durationS)}</td>
                      <td className={styles.errCell} title={r.error ?? undefined}>
                        {r.error ? truncate(r.error) : "—"}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={8} className={styles.empty}>
                      Нет данных
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
