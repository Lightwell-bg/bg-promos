import { useState } from "react";
import type { Series, SeriesPoint } from "../../data/adminApi";
import styles from "../Admin.module.css";
import { bucketLabel, niceTicks } from "./adminUtils";

/** Inline SVG charts (no chart library: bundle size). Colors come from CSS tokens. */

export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const w = 100;
  const h = 24;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`);
  return (
    <svg className={styles.spark} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <polyline points={pts.join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export type ChartMetric = "users" | "sessions" | "cartUsers";

export const CHART_METRICS: { id: ChartMetric; label: string }[] = [
  { id: "users", label: "Пользователи" },
  { id: "sessions", label: "Сессии" },
  { id: "cartUsers", label: "Корзина" },
];

const W = 640;
const H = 240;
const M = { l: 34, r: 12, t: 12, b: 28 };

function path(values: number[], x: (i: number) => number, y: (v: number) => number): string {
  return values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
}

export function TrendChart({ series, metric }: { series: Series; metric: ChartMetric }) {
  const [active, setActive] = useState<number | null>(null);
  const pts: SeriesPoint[] = series.points;
  const prev: SeriesPoint[] = series.previousPoints;
  const cur = pts.map((p) => p[metric]);
  const old = pts.map((_, i) => prev[i]?.[metric] ?? 0);
  const ticks = niceTicks(Math.max(0, ...cur, ...old));
  const top = ticks[ticks.length - 1];
  const n = pts.length;
  const innerW = W - M.l - M.r;
  const innerH = H - M.t - M.b;
  const x = (i: number) => M.l + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => M.t + innerH - (v / top) * innerH;
  const stride = Math.max(1, Math.ceil(n / 6));
  const slot = innerW / Math.max(n, 1);
  const label = (p: SeriesPoint | undefined) => (p ? bucketLabel(p.t, series.bucket) : "—");
  const tip = active !== null && pts[active] ? active : null;

  return (
    <div>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="График: текущий и прошлый период"
        data-bucket={series.bucket}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} className={styles.grid} />
            <text x={M.l - 6} y={y(t) + 4} textAnchor="end" className={styles.axis}>
              {t}
            </text>
          </g>
        ))}
        {pts.map((p, i) =>
          i % stride === 0 ? (
            <text key={p.t || i} x={x(i)} y={H - 8} textAnchor="middle" className={`${styles.axis} ${styles.xLabel}`}>
              {bucketLabel(p.t, series.bucket)}
            </text>
          ) : null,
        )}
        {n > 0 && <path d={path(old, x, y)} data-series="previous" className={styles.linePrev} fill="none" />}
        {n > 0 && <path d={path(cur, x, y)} data-series="current" className={styles.lineCur} fill="none" />}
        {tip !== null && (
          <g>
            <line x1={x(tip)} x2={x(tip)} y1={M.t} y2={M.t + innerH} className={styles.grid} />
            <circle cx={x(tip)} cy={y(old[tip])} r="4" className={styles.dotPrev} />
            <circle cx={x(tip)} cy={y(cur[tip])} r="4" className={styles.dotCur} />
          </g>
        )}
        {pts.map((p, i) => (
          <rect
            key={`hit-${p.t || i}`}
            data-hit={i}
            x={x(i) - slot / 2}
            y={M.t}
            width={slot}
            height={innerH}
            fill="transparent"
            onPointerEnter={() => setActive(i)}
            onClick={() => setActive(i)}
          />
        ))}
      </svg>
      <ul className={styles.legend} aria-label="Легенда">
        <li>
          <span className={styles.swatchCur} aria-hidden="true" />
          Текущий период
        </li>
        <li>
          <span className={styles.swatchPrev} aria-hidden="true" />
          Прошлый период
        </li>
      </ul>
      <p className={styles.tooltip} role="status">
        {tip === null
          ? "Наведите или коснитесь точки графика, чтобы увидеть значения"
          : `${label(pts[tip])}: текущий ${cur[tip]} · прошлый (${label(prev[tip])}) ${old[tip]}`}
      </p>
    </div>
  );
}
