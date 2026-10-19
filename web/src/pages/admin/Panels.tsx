import { useState } from "react";
import type { AdminError, Funnel, Metrics } from "../../data/adminApi";
import styles from "../Admin.module.css";
import { Sparkline } from "./Charts";
import { formatDelta, fmtTime, platformLabel, sourceLabel } from "./adminUtils";

/** Dashboard blocks: KPI cards, funnel, platforms, sources, errors. All values are rendered as text. */

export function DeltaText({ current, previous }: { current: number; previous: number }) {
  const d = formatDelta(current, previous);
  const cls = d.kind === "up" || d.kind === "new" ? styles.up : d.kind === "down" ? styles.down : styles.flat;
  return <span className={`${styles.delta} ${cls}`}>{d.text}</span>;
}

type SeriesKey = "users" | "sessions" | "botStarts" | "miniappOpens" | "siteOpens" | "cartUsers";

interface KpiDef {
  label: string;
  value: (m: Metrics["kpi"]) => number;
  spark?: SeriesKey;
  hint?: string;
}

const KPI_DEFS: KpiDef[] = [
  { label: "Пользователи", value: (k) => k.users, spark: "users" },
  { label: "Сессии", value: (k) => k.sessions, spark: "sessions" },
  { label: "Запуски бота", value: (k) => k.botStarts, spark: "botStarts" },
  { label: "Открытия Mini App", value: (k) => k.miniappOpens, spark: "miniappOpens" },
  { label: "Открытия сайта", value: (k) => k.siteOpens, spark: "siteOpens" },
  { label: "Добавили в корзину", value: (k) => k.cartAddUsers, spark: "cartUsers", hint: "пользователей" },
  { label: "Ссылок «Поделиться»", value: (k) => k.shareLinks },
  { label: "Успешных импортов", value: (k) => k.importsOk },
];

export function KpiCards({ metrics }: { metrics: Metrics | null }) {
  const k = metrics?.kpi;
  const p = metrics?.previous;
  return (
    <section aria-label="Показатели" className={styles.tiles}>
      {KPI_DEFS.map((def) => {
        const cur = k ? def.value(k) : 0;
        const prev = p ? def.value(p) : 0;
        const hint =
          def.label === "Пользователи"
            ? `новые ${k?.newUsers ?? 0} · вернувшиеся ${k?.returningUsers ?? 0}`
            : def.hint;
        return (
          <div key={def.label} className={styles.tile} data-kpi={def.label}>
            <span className={styles.tileLabel}>{def.label}</span>
            <strong className={styles.tileValue}>{cur}</strong>
            <DeltaText current={cur} previous={prev} />
            {hint && <span className={styles.tileHint}>{hint}</span>}
            {def.spark && metrics && <Sparkline values={metrics.series.points.map((pt) => pt[def.spark as SeriesKey])} />}
          </div>
        );
      })}
    </section>
  );
}

const FUNNEL_STEPS: { key: keyof Funnel; label: string }[] = [
  { key: "opened", label: "Открыли" },
  { key: "catalogLoaded", label: "Каталог" },
  { key: "offerView", label: "Смотрели товар" },
  { key: "cartAdd", label: "Добавили в корзину" },
  { key: "shareLinkCreated", label: "Поделились" },
];

export function FunnelPanel({ funnel, previous }: { funnel: Funnel; previous: Funnel }) {
  const base = funnel.opened;
  return (
    <section className={styles.panel} aria-label="Воронка">
      <h2>Воронка</h2>
      <ol className={styles.funnel}>
        {FUNNEL_STEPS.map((s) => {
          const v = funnel[s.key];
          const pct = base > 0 ? Math.round((v / base) * 100) : 0;
          return (
            <li key={s.key} className={styles.funnelRow}>
              <div className={styles.funnelHead}>
                <span>{s.label}</span>
                <span>
                  <strong>{v}</strong> · {pct}% от «Открыли»
                </span>
              </div>
              <div className={styles.barTrack} aria-hidden="true">
                <div className={styles.bar} style={{ width: `${Math.min(100, pct)}%` }} />
              </div>
              <DeltaText current={v} previous={previous[s.key]} />
            </li>
          );
        })}
      </ol>
      <p className={styles.note}>Шаги считаются независимо</p>
    </section>
  );
}

export function PlatformsPanel({ platforms }: { platforms: Metrics["platforms"] }) {
  return (
    <section className={styles.panel} aria-label="Платформы">
      <h2>Платформы</h2>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Платформа</th>
              <th>Пользователи</th>
              <th>Сессии</th>
            </tr>
          </thead>
          <tbody>
            {platforms.length ? (
              platforms.map((p) => (
                <tr key={p.platform}>
                  <td>{platformLabel(p.platform)}</td>
                  <td>
                    {p.users} <DeltaText current={p.users} previous={p.previousUsers} />
                  </td>
                  <td>
                    {p.sessions} <DeltaText current={p.sessions} previous={p.previousSessions} />
                  </td>
                </tr>
              ))
            ) : (
              <EmptyRow cols={3} />
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function SourcesPanel({ sources }: { sources: Metrics["sources"] }) {
  return (
    <section className={styles.panel} aria-label="Источники">
      <h2>Источники</h2>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Источник</th>
              <th>Пользователи</th>
              <th>Новые</th>
              <th>Сессии</th>
              <th>Корзина</th>
              <th>Δ к прошлому периоду</th>
            </tr>
          </thead>
          <tbody>
            {sources.length ? (
              sources.map((s, i) => (
                <tr key={`${s.kind}|${s.source ?? ""}|${s.campaign ?? ""}|${i}`}>
                  <td>{sourceLabel(s.kind, s.source, s.campaign)}</td>
                  <td>{s.users}</td>
                  <td>{s.newUsers}</td>
                  <td>{s.sessions}</td>
                  <td>{s.cartUsers}</td>
                  <td>
                    <DeltaText current={s.users} previous={s.previousUsers} />
                  </td>
                </tr>
              ))
            ) : (
              <EmptyRow cols={6} />
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function EmptyRow({ cols }: { cols: number }) {
  return (
    <tr>
      <td colSpan={cols} className={styles.empty}>
        Нет данных за период
      </td>
    </tr>
  );
}

/** One error group; click expands the page path and the stack (plain text, React-escaped). */
function ErrorRow({ error: e }: { error: AdminError }) {
  const [open, setOpen] = useState(false);
  const title = e.message ? `${e.name}: ${e.message}` : e.name;
  const where = e.source ? `${e.where} · ${e.source}` : e.where;
  const loc = e.file ? (e.line !== null ? `${e.file}:${e.line}${e.col !== null ? `:${e.col}` : ""}` : e.file) : "—";
  return (
    <>
      <tr className={styles.errRow} onClick={() => setOpen((v) => !v)}>
        <td className={styles.errTitle}>
          <button
            type="button"
            className={styles.link}
            aria-expanded={open}
            onClick={(ev) => {
              ev.stopPropagation();
              setOpen((v) => !v);
            }}
          >
            {title}
          </button>
        </td>
        <td>{where}</td>
        <td>{loc}</td>
        <td>{e.count}</td>
        <td>{fmtTime(e.lastSeen)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} className={styles.errDetail}>
            <div>Страница: {e.path || "—"}</div>
            <pre className={styles.stack}>{e.stack || "Стек недоступен"}</pre>
          </td>
        </tr>
      )}
    </>
  );
}

function ErrorTable({ errors }: { errors: AdminError[] }) {
  return (
    <div className={styles.scroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Ошибка</th>
            <th>Где</th>
            <th>Файл:строка</th>
            <th>Количество</th>
            <th>Последний раз</th>
          </tr>
        </thead>
        <tbody>
          {errors.length ? (
            errors.map((e, i) => (
              <ErrorRow
                key={`${e.name}|${e.where}|${e.message ?? ""}|${e.source ?? ""}|${e.file ?? ""}|${e.line ?? ""}|${i}`}
                error={e}
              />
            ))
          ) : (
            <EmptyRow cols={5} />
          )}
        </tbody>
      </table>
    </div>
  );
}

export function ErrorsPanel({ errors }: { errors: AdminError[] }) {
  const [showNoise, setShowNoise] = useState(false);
  const real = errors.filter((e) => !e.noise);
  const noise = errors.filter((e) => e.noise);
  return (
    <section className={styles.panel} aria-label="Ошибки">
      <h2>Ошибки</h2>
      <ErrorTable errors={real} />
      {noise.length > 0 && (
        <div className={styles.noise}>
          <button type="button" className={styles.link} aria-expanded={showNoise} onClick={() => setShowNoise((v) => !v)}>
            {`Шум внешних скриптов (${noise.length})`}
          </button>
          <p className={styles.note}>
            Ошибки сторонних скриптов (Clarity, GA4, Telegram) — браузер скрывает их текст, на работу сайта обычно не влияют
          </p>
          {showNoise && <ErrorTable errors={noise} />}
        </div>
      )}
    </section>
  );
}
