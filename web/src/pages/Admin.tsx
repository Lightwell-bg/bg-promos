import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
  AdminAuthError,
  AdminHttpError,
  USERS_PAGE_SIZE,
  adminLogin,
  adminLogout,
  deleteUser,
  getFilters,
  getMetrics,
  getUser,
  getUsers,
  type AdminFilterOptions,
  type AdminQuery,
  type Metrics,
  type UserCard,
  type UsersPage,
} from "../data/adminApi";
import { useCatalog } from "../data/CatalogContext";
import { todaySofia } from "../domain/dates";
import { LangProvider } from "../i18n/LangContext";
import { setRobotsNoindex, setTitle } from "../platform/document";
import styles from "./Admin.module.css";
import { CHART_METRICS, TrendChart, type ChartMetric } from "./admin/Charts";
import { Collection } from "./admin/Collection";
import { ErrorsPanel, EmptyRow, FunnelPanel, KpiCards, PlatformsPanel, SourcesPanel } from "./admin/Panels";
import {
  NO_SOURCE,
  PRESETS,
  fmtTime,
  loadPreset,
  presetRange,
  rangeLabel,
  savePreset,
  type PresetId,
} from "./admin/adminUtils";

/** Closed stats section (route /admin). Russian UI, mobile friendly, masked in Clarity, never indexed. */

const ANON_TEXT = "Личность неизвестна — анонимный посетитель сайта";

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const res = await adminLogin(password);
    setBusy(false);
    if (res === "ok") {
      setPassword("");
      onDone();
      return;
    }
    setError(
      res === "bad_password"
        ? "Неверный пароль"
        : res === "rate_limited"
          ? "Слишком много попыток. Попробуйте позже."
          : res === "disabled"
            ? "Раздел статистики отключён на сервере"
            : "Не удалось войти. Проверьте соединение.",
    );
  }

  return (
    <form className={styles.login} onSubmit={submit}>
      <h1>Статистика</h1>
      <label className={styles.field}>
        <span>Пароль</span>
        <input
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <button type="submit" className={styles.primary} disabled={busy || !password}>
        Войти
      </button>
    </form>
  );
}

const Empty = EmptyRow;

function Dashboard({
  query,
  onQuery,
  preset,
  onPreset,
  options,
  onAuthLost,
  onOpenUser,
  refreshKey,
}: {
  query: AdminQuery;
  onQuery: (q: AdminQuery) => void;
  preset: PresetId;
  onPreset: (id: PresetId) => void;
  options: AdminFilterOptions;
  onAuthLost: () => void;
  onOpenUser: (id: string) => void;
  refreshKey: number;
}) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [failed, setFailed] = useState(false);
  const [users, setUsers] = useState<UsersPage | null>(null);
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  const [page, setPage] = useState(1);
  const seq = useRef(0);
  // The backend returns offer ids only: names and chains come from the public catalog.
  const { catalog } = useCatalog();
  const offerLabel = (id: string, chain: string | null): string => {
    const o = catalog?.offers.find((x) => x.id === id);
    if (o) return `${o.name} (${o.chain})`;
    return chain ? `${id} (${chain})` : id;
  };

  useEffect(() => {
    const my = ++seq.current;
    setFailed(false);
    getMetrics(query)
      .then((m) => {
        if (my === seq.current) setMetrics(m);
      })
      .catch((e) => {
        if (e instanceof AdminAuthError) onAuthLost();
        else if (my === seq.current) setFailed(true);
      });
  }, [query, onAuthLost, refreshKey]);

  useEffect(() => {
    let alive = true;
    getUsers(query, applied, page)
      .then((u) => alive && setUsers(u))
      .catch((e) => {
        if (e instanceof AdminAuthError) onAuthLost();
        else if (alive) setUsers({ total: 0, items: [] });
      });
    return () => {
      alive = false;
    };
  }, [query, applied, page, onAuthLost, refreshKey]);

  const [metric, setMetric] = useState<ChartMetric>("users");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilters =
    [query.platform, query.lang, query.sourceKind, query.source, query.campaign].filter(Boolean).length +
    (query.includeTest ? 1 : 0);
  const pages = users ? Math.max(1, Math.ceil(users.total / USERS_PAGE_SIZE)) : 1;
  const set = (patch: Partial<AdminQuery>) => {
    setPage(1);
    onQuery({ ...query, ...patch });
  };

  function select(name: keyof AdminQuery, label: string, values: string[]) {
    return (
      <label className={styles.field}>
        <span>{label}</span>
        <select value={String(query[name])} onChange={(e) => set({ [name]: e.target.value } as Partial<AdminQuery>)}>
          <option value="">Все</option>
          {values.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <>
      <section className={styles.panel} aria-label="Период и фильтры">
        <div className={styles.presets} role="group" aria-label="Период">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={preset === p.id}
              className={`${styles.chip} ${preset === p.id ? styles.chipOn : ""}`}
              onClick={() => {
                setPage(1);
                onPreset(p.id);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <div className={styles.filters}>
            <label className={styles.field}>
              <span>С</span>
              <input type="date" value={query.from} max={query.to} onChange={(e) => e.target.value && set({ from: e.target.value })} />
            </label>
            <label className={styles.field}>
              <span>По</span>
              <input type="date" value={query.to} min={query.from} onChange={(e) => e.target.value && set({ to: e.target.value })} />
            </label>
          </div>
        )}
        <p className={styles.note}>
          Период: {rangeLabel(query.from, query.to)}
          {metrics?.previousRange.from ? ` · Сравнение с: ${rangeLabel(metrics.previousRange.from, metrics.previousRange.to)}` : ""}
        </p>
        <button
          type="button"
          className={styles.link}
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((v) => !v)}
        >
          {activeFilters ? `Фильтры (${activeFilters})` : "Фильтры"}
        </button>
        {filtersOpen && (
          <div className={styles.filters}>
            {select("platform", "Платформа", options.platforms)}
            {select("lang", "Язык", options.langs)}
            {select("sourceKind", "Тип источника", options.sourceKinds)}
            {select("source", "Источник", options.sources)}
            {select("campaign", "Кампания", options.campaigns)}
            <label className={styles.check}>
              <input type="checkbox" checked={query.includeTest} onChange={(e) => set({ includeTest: e.target.checked })} />
              <span>Включить тестовый и автоматический трафик</span>
            </label>
          </div>
        )}
      </section>

      {failed && (
        <p role="alert" className={styles.error}>
          Не удалось загрузить статистику
        </p>
      )}

      <KpiCards metrics={metrics} />

      {metrics && (
        <section className={styles.panel} aria-label="Динамика">
          <h2>Динамика</h2>
          <div className={styles.presets} role="group" aria-label="Метрика графика">
            {CHART_METRICS.map((m) => (
              <button
                key={m.id}
                type="button"
                aria-pressed={metric === m.id}
                className={`${styles.chip} ${metric === m.id ? styles.chipOn : ""}`}
                onClick={() => setMetric(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <TrendChart series={metrics.series} metric={metric} />
        </section>
      )}

      {metrics && <FunnelPanel funnel={metrics.funnel} previous={metrics.previousFunnel} />}
      {metrics && <PlatformsPanel platforms={metrics.platforms} />}
      {metrics && <SourcesPanel sources={metrics.sources} />}

      <section className={styles.panel} aria-label="Топ предложений">
        <h2>Топ предложений</h2>
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Предложение</th>
                <th>Просмотры</th>
                <th>Добавления в корзину</th>
              </tr>
            </thead>
            <tbody>
              {metrics?.topOffers.length ? (
                metrics.topOffers.map((o) => (
                  <tr key={`${o.chain ?? ""}|${o.offerId}`}>
                    <td>{offerLabel(o.offerId, o.chain)}</td>
                    <td>{o.views}</td>
                    <td>{o.adds}</td>
                  </tr>
                ))
              ) : (
                <Empty cols={3} />
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.panel} aria-label="Запросы без результатов">
        <h2>Запросы без результатов</h2>
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Запрос</th>
                <th>Количество</th>
              </tr>
            </thead>
            <tbody>
              {metrics?.zeroQueries.length ? (
                metrics.zeroQueries.map((q) => (
                  <tr key={q.query}>
                    <td>{q.query}</td>
                    <td>{q.count}</td>
                  </tr>
                ))
              ) : (
                <Empty cols={2} />
              )}
            </tbody>
          </table>
        </div>
      </section>

      <ErrorsPanel errors={metrics?.errors ?? []} />

      <section className={styles.panel} aria-label="Пользователи">
        <h2>Пользователи</h2>
        <form
          className={styles.searchRow}
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setApplied(search);
          }}
        >
          <input
            type="search"
            value={search}
            placeholder="Поиск: Telegram ID, username, имя"
            aria-label="Поиск пользователей"
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="submit" className={styles.primary}>
            Найти
          </button>
        </form>
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Telegram ID</th>
                <th>Username</th>
                <th>Имя</th>
                <th>Фамилия</th>
                <th>Первый визит</th>
                <th>Последний визит</th>
                <th>Первый источник</th>
                <th>Сессии</th>
                <th>В корзину</th>
              </tr>
            </thead>
            <tbody>
              {users?.items.length ? (
                users.items.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <button type="button" className={styles.link} onClick={() => onOpenUser(u.id)}>
                        {u.tgId ?? "Анонимный"}
                      </button>
                    </td>
                    <td>{u.username ? `@${u.username}` : "—"}</td>
                    <td>{u.kind === "anon" ? "—" : (u.firstName ?? "—")}</td>
                    <td>{u.kind === "anon" ? "—" : (u.lastName ?? "—")}</td>
                    <td>{fmtTime(u.firstSeen)}</td>
                    <td>{fmtTime(u.lastSeen)}</td>
                    <td>{u.firstSource ?? NO_SOURCE}</td>
                    <td>{u.sessions}</td>
                    <td>{u.cartAdds}</td>
                  </tr>
                ))
              ) : (
                <Empty cols={9} />
              )}
            </tbody>
          </table>
        </div>
        <div className={styles.pager}>
          <button type="button" className={styles.chip} disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Назад
          </button>
          <span>
            Страница {page} из {pages} · всего {users?.total ?? 0}
          </span>
          <button type="button" className={styles.chip} disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Вперёд
          </button>
        </div>
      </section>
    </>
  );
}

function UserView({
  id,
  onBack,
  onDeleted,
  onAuthLost,
}: {
  id: string;
  onBack: () => void;
  onDeleted: () => void;
  onAuthLost: () => void;
}) {
  const [card, setCard] = useState<UserCard | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getUser(id)
      .then((c) => alive && setCard(c))
      .catch((e) => {
        if (e instanceof AdminAuthError) onAuthLost();
        else if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [id, onAuthLost]);

  async function remove() {
    setBusy(true);
    try {
      await deleteUser(id);
      setConfirming(false);
      onDeleted();
    } catch (e) {
      setConfirming(false);
      if (e instanceof AdminAuthError) onAuthLost();
      else setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const u = card?.user;
  return (
    <>
      <button type="button" className={styles.chip} onClick={onBack}>
        ← К списку
      </button>
      {failed && (
        <p role="alert" className={styles.error}>
          Не удалось загрузить данные пользователя
        </p>
      )}
      {card && u && (
        <>
          <section className={styles.panel} aria-label="Профиль">
            <h2>Профиль</h2>
            {u.kind === "anon" ? (
              <p>{ANON_TEXT}</p>
            ) : (
              <dl className={styles.profile}>
                <dt>Telegram ID</dt>
                <dd>{u.tgId ?? "—"}</dd>
                <dt>Username</dt>
                <dd>{u.username ? `@${u.username}` : "—"}</dd>
                <dt>Имя</dt>
                <dd>{u.firstName ?? "—"}</dd>
                <dt>Фамилия</dt>
                <dd>{u.lastName ?? "—"}</dd>
                <dt>Язык Telegram</dt>
                <dd>{u.language ?? "—"}</dd>
              </dl>
            )}
            <dl className={styles.profile}>
              <dt>Первый визит</dt>
              <dd>{fmtTime(u.firstSeen)}</dd>
              <dt>Последний визит</dt>
              <dd>{fmtTime(u.lastSeen)}</dd>
              <dt>Первый источник</dt>
              <dd>{u.firstSource ?? NO_SOURCE}</dd>
              <dt>Сессии</dt>
              <dd>{u.sessions}</dd>
              <dt>Добавлений в корзину</dt>
              <dd>{u.cartAdds}</dd>
            </dl>
            <button type="button" className={styles.danger} onClick={() => setConfirming(true)} disabled={busy}>
              Удалить пользователя
            </button>
          </section>

          <section className={styles.panel} aria-label="Сессии">
            <h2>Сессии</h2>
            <div className={styles.scroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Начало</th>
                    <th>Платформа</th>
                    <th>Источник</th>
                    <th>Язык</th>
                  </tr>
                </thead>
                <tbody>
                  {card.sessions.length ? (
                    card.sessions.map((s) => (
                      <tr key={s.id}>
                        <td>{fmtTime(s.startedAt)}</td>
                        <td>{s.platform || "—"}</td>
                        <td>{s.source ?? NO_SOURCE}{s.inherited ? " (унаследован)" : ""}</td>
                        <td>{s.lang ?? "—"}</td>
                      </tr>
                    ))
                  ) : (
                    <Empty cols={4} />
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className={styles.panel} aria-label="События">
            <h2>События</h2>
            {card.events.length ? (
              <ol className={styles.timeline}>
                {card.events.map((e, i) => (
                  <li key={`${e.ts}-${i}`}>
                    <time>{fmtTime(e.ts)}</time> <strong>{e.name}</strong>
                    {e.platform ? ` · ${e.platform}` : ""}
                    {e.props ? <code className={styles.props}>{e.props}</code> : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p className={styles.empty}>Нет событий</p>
            )}
          </section>
        </>
      )}
      {confirming && (
        <ConfirmDialog
          title="Удалить пользователя?"
          text="Будут удалены профиль, сессии и события. Действие необратимо."
          confirmLabel="Удалить"
          onClose={() => setConfirming(false)}
          onConfirm={() => void remove()}
        />
      )}
    </>
  );
}

const EMPTY_OPTIONS: AdminFilterOptions = { platforms: [], langs: [], sourceKinds: [], sources: [], campaigns: [] };

function initialQuery(preset: PresetId): AdminQuery {
  const range = presetRange(preset, todaySofia()) as { from: string; to: string };
  return {
    from: range.from,
    to: range.to,
    platform: "",
    lang: "",
    sourceKind: "",
    source: "",
    campaign: "",
    includeTest: false,
  };
}

export function Admin() {
  // null = checking the session; false = login form; true = dashboard.
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [options, setOptions] = useState<AdminFilterOptions>(EMPTY_OPTIONS);
  const [preset, setPreset] = useState<PresetId>(loadPreset);
  const [query, setQuery] = useState<AdminQuery>(() => initialQuery(preset));

  /** A preset recomputes the range from the Sofia "today"; "custom" keeps the current range. Always a new query object (refetch). */
  const choosePreset = useCallback((id: PresetId) => {
    setPreset(id);
    savePreset(id);
    setQuery((q) => {
      const range = presetRange(id, todaySofia());
      return range ? { ...q, ...range } : { ...q };
    });
  }, []);
  const [userId, setUserId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [tab, setTab] = useState<"stats" | "collection">("stats");

  useEffect(() => {
    setTitle("Статистика");
    setRobotsNoindex(true);
    return () => setRobotsNoindex(false);
  }, []);

  const authLost = useCallback(() => {
    setAuthed(false);
    setUserId(null);
  }, []);

  const enter = useCallback(() => {
    getFilters()
      .then((o) => {
        setOptions(o);
        setAuthed(true);
      })
      .catch((e) => {
        if (e instanceof AdminAuthError || (e instanceof AdminHttpError && e.status === 404)) setAuthed(false);
        else setAuthed(true); // logged in, only the filter lists failed
      });
  }, []);

  useEffect(() => enter(), [enter]);

  async function logout() {
    await adminLogout();
    authLost();
  }

  return (
    <LangProvider lang="ru">
      <div className={styles.page} data-clarity-mask="true" lang="ru">
        {authed === null && <p role="status">Загрузка…</p>}
        {authed === false && <Login onDone={enter} />}
        {authed === true && (
          <>
            <header className={styles.header}>
              <h1>Статистика</h1>
              <button type="button" className={styles.chip} onClick={() => void logout()}>
                Выйти
              </button>
            </header>
            {userId ? (
              <UserView
                id={userId}
                onBack={() => setUserId(null)}
                onDeleted={() => {
                  setUserId(null);
                  setRefreshKey((n) => n + 1);
                }}
                onAuthLost={authLost}
              />
            ) : (
              <>
                <div className={styles.tabs} role="group" aria-label="Раздел">
                  {(
                    [
                      ["stats", "Статистика"],
                      ["collection", "Сбор данных"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={tab === id}
                      className={`${styles.chip} ${tab === id ? styles.chipOn : ""}`}
                      onClick={() => setTab(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {tab === "collection" ? (
                  <Collection onAuthLost={authLost} />
                ) : (
                  <Dashboard
                    query={query}
                    onQuery={setQuery}
                    preset={preset}
                    onPreset={choosePreset}
                    options={options}
                    onAuthLost={authLost}
                    onOpenUser={setUserId}
                    refreshKey={refreshKey}
                  />
                )}
              </>
            )}
          </>
        )}
      </div>
    </LangProvider>
  );
}
