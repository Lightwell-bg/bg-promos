import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import filtersFixture from "../__fixtures__/admin/filters.json";
import metricsFixture from "../__fixtures__/admin/metrics.json";
import userCardAnon from "../__fixtures__/admin/user_card_anon.json";
import userCardTg from "../__fixtures__/admin/user_card_tg.json";
import usersFixture from "../__fixtures__/admin/users.json";
import { sampleCatalog } from "../__fixtures__";
import { CatalogProvider } from "../data/CatalogContext";
import { CATALOG_KEY, CatalogStore } from "../data/catalogStore";
import { todaySofia } from "../domain/dates";
import { createMemoryStorage } from "../platform/storage";
import { Admin } from "./Admin";

interface Req {
  method: string;
  url: string;
  init?: RequestInit;
}

let loggedIn = false;
let reqs: Req[] = [];
let metricsStatus = 200;
let loginStatus = 0;

// Mocked responses are the shared contract fixtures; tests/test_analytics_contract.py asserts
// that the real backend responses have exactly these keys and types.
const METRICS = metricsFixture;
/** Response served for /api/admin/metrics (tests may swap it). */
let metricsData: unknown = METRICS;
const USERS = usersFixture;
const CARDS: Record<string, unknown> = {
  [userCardTg.visitor_id]: userCardTg,
  [userCardAnon.visitor_id]: userCardAnon,
};
const TG_ID = userCardTg.visitor_id;
const ANON_ID = userCardAnon.visitor_id;
const UNKNOWN_SOURCE = { kind: "unknown", source: null, medium: null, campaign: null, placement: null };
/** When true the anonymous visitor has no attributable source (backend: kind "unknown"). */
let anonUnknown = false;
/** When true the first session of the Telegram card carries an inherited source. */
let inheritedSession = false;

function users() {
  const d = structuredClone(USERS);
  if (anonUnknown) d.items[1].first_source = UNKNOWN_SOURCE as never;
  return d;
}

function json(status: number, data: unknown = {}): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as unknown as Response;
}

function handle(method: string, url: string, init?: RequestInit): Response {
  if (method === "POST" && url === "/api/admin/login") {
    if (loginStatus) return json(loginStatus, { detail: "x" });
    const body = JSON.parse(init?.body as string);
    if (body.password === "secret") {
      loggedIn = true;
      return json(200, { ok: true });
    }
    return json(401, { detail: "wrong password" });
  }
  if (method === "POST" && url === "/api/admin/logout") {
    loggedIn = false;
    return json(200, { ok: true });
  }
  if (!loggedIn) return json(401);
  if (url === "/api/admin/filters") return json(200, filtersFixture);
  if (url.startsWith("/api/admin/metrics")) return metricsStatus === 200 ? json(200, metricsData) : json(metricsStatus);
  if (url.startsWith("/api/admin/users?")) return json(200, users());
  if (method === "POST" && url === "/api/admin/users/search") return json(200, users());
  if (method === "GET" && url.startsWith("/api/admin/users/")) {
    const id = decodeURIComponent(url.split("/").pop() as string);
    const card = structuredClone(CARDS[id]) as { first_source: unknown } | undefined;
    if (!card) return json(404);
    if (anonUnknown && id === ANON_ID) card.first_source = UNKNOWN_SOURCE;
    if (inheritedSession) (card as unknown as { sessions: { source_inherited: boolean }[] }).sessions[0].source_inherited = true;
    return json(200, card);
  }
  if (method === "DELETE" && url.startsWith("/api/admin/users/")) return json(200, { ok: true });
  return json(404);
}

beforeEach(() => {
  loggedIn = false;
  anonUnknown = false;
  inheritedSession = false;
  metricsStatus = 200;
  metricsData = METRICS;
  loginStatus = 0;
  reqs = [];
  localStorage.clear();
  document.head.innerHTML = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      reqs.push({ method, url, init });
      return handle(method, url, init);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderAdmin() {
  const storage = createMemoryStorage();
  await storage.set(CATALOG_KEY, { catalog: sampleCatalog(), etag: '"v1"', checkedAt: Date.now() });
  const store = new CatalogStore({ storage, fetchFn: () => Promise.reject(new Error("offline")) });
  return render(
    <MemoryRouter initialEntries={["/admin"]}>
      <CatalogProvider store={store}>
        <Admin />
      </CatalogProvider>
    </MemoryRouter>,
  );
}

async function login() {
  await userEvent.type(await screen.findByLabelText("Пароль"), "secret");
  await userEvent.click(screen.getByRole("button", { name: "Войти" }));
  await screen.findByRole("region", { name: "Показатели" });
}

async function openFilters() {
  await userEvent.click(screen.getByRole("button", { name: /^Фильтры/ }));
}

const lastMetricsParams = () => {
  const last = reqs.filter((r) => r.url.startsWith("/api/admin/metrics")).pop() as Req;
  return new URL(last.url, "http://x").searchParams;
};

describe("admin login", () => {
  it("shows the login form without a session, rejects a wrong password, then opens the dashboard", async () => {
    await renderAdmin();
    await userEvent.type(await screen.findByLabelText("Пароль"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Войти" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Неверный пароль");
    expect(screen.queryByRole("region", { name: "Показатели" })).toBeNull();

    await userEvent.clear(screen.getByLabelText("Пароль"));
    await userEvent.type(screen.getByLabelText("Пароль"), "secret");
    await userEvent.click(screen.getByRole("button", { name: "Войти" }));
    expect(await screen.findByRole("region", { name: "Показатели" })).toBeInTheDocument();

    const loginReq = reqs.find((r) => r.url === "/api/admin/login" && r.init?.body && JSON.parse(r.init.body as string).password === "secret");
    expect(loginReq?.init?.credentials).toBe("same-origin");
  });

  it("429 -> rate-limit message, 404 -> 'disabled on the server'", async () => {
    await renderAdmin();
    await userEvent.type(await screen.findByLabelText("Пароль"), "secret");
    loginStatus = 429;
    await userEvent.click(screen.getByRole("button", { name: "Войти" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Слишком много попыток");
    loginStatus = 404;
    await userEvent.click(screen.getByRole("button", { name: "Войти" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("отключён на сервере"));
  });

  it("a 401 from the API sends the user back to the login form", async () => {
    await renderAdmin();
    await login();
    metricsStatus = 401;
    await userEvent.click(screen.getByRole("button", { name: "7 дней" }));
    expect(await screen.findByLabelText("Пароль")).toBeInTheDocument();
  });

  it("logout returns to the login form", async () => {
    await renderAdmin();
    await login();
    await userEvent.click(screen.getByRole("button", { name: "Выйти" }));
    expect(await screen.findByLabelText("Пароль")).toBeInTheDocument();
    expect(reqs.some((r) => r.method === "POST" && r.url === "/api/admin/logout")).toBe(true);
  });

  it("is masked for Clarity and not indexable", async () => {
    const { container } = await renderAdmin();
    await screen.findByLabelText("Пароль");
    expect(container.querySelector('[data-clarity-mask="true"]')).not.toBeNull();
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex");
  });
});

describe("admin dashboard", () => {
  it("renders the KPI tiles, tables and honest wording from the backend shape", async () => {
    const { container } = await renderAdmin();
    await login();
    const tiles = screen.getByRole("region", { name: "Показатели" });
    await within(tiles).findByText("новые 2 · вернувшиеся 0");
    const tile = (label: string) => within(tiles).getByText(label).parentElement as HTMLElement;
    expect(tile("Пользователи")).toHaveTextContent("2");
    expect(tile("Пользователи")).toHaveTextContent("▲ 100% (было 1)");
    expect(tile("Сессии")).toHaveTextContent("2");
    expect(tile("Запуски бота")).toHaveTextContent("= (было 0)");
    expect(tile("Открытия Mini App")).toHaveTextContent("▲ новое (было 0)");
    expect(tile("Открытия сайта")).toHaveTextContent("= (было 1)");
    expect(tile("Добавили в корзину")).toHaveTextContent("1");
    expect(tile("Ссылок «Поделиться»")).toHaveTextContent("1");
    expect(tile("Успешных импортов")).toHaveTextContent("1");
    expect(screen.getByText(/Сравнение с: 05\.10–11\.10/)).toBeInTheDocument();

    expect(screen.getByRole("region", { name: "Запросы без результатов" })).toHaveTextContent("kinoa");
    expect(screen.getByRole("region", { name: "Ошибки" })).toHaveTextContent("TypeError: x is undefined");

    const text = container.textContent ?? "";
    expect(text).not.toMatch(/выручк|покупок|продаж|отправлен/i);
  });

  it("errors table: details columns, row expands to the page path and the stack as text", async () => {
    await renderAdmin();
    await login();
    const region = screen.getByRole("region", { name: "Ошибки" });
    expect(region).toHaveTextContent("boundary · own");
    expect(region).toHaveTextContent("/assets/index-abc.js:10:5");
    expect(region).not.toHaveTextContent("Страница:");
    await userEvent.click(within(region).getByRole("button", { name: "TypeError: x is undefined" }));
    expect(region).toHaveTextContent("Страница: /ru/cart");
    const pre = region.querySelector("pre") as HTMLElement;
    expect(pre.textContent).toContain("at f (/assets/index-abc.js:10:5)");
    await userEvent.click(within(region).getByRole("button", { name: "TypeError: x is undefined" }));
    expect(region.querySelector("pre")).toBeNull();
  });

  it("top offers: ids are resolved to names from the catalog, unknown ids fall back to the id", async () => {
    await renderAdmin();
    await login();
    const offers = screen.getByRole("region", { name: "Топ предложений" });
    await waitFor(() => expect(offers).toHaveTextContent("Прясно мляко Pilos 3,6% (lidl)"));
    const rows = within(offers).getAllByRole("row");
    // views and cart adds of one offer are merged into one row
    expect(rows[1]).toHaveTextContent("Прясно мляко Pilos 3,6% (lidl)");
    expect(rows[1].querySelectorAll("td")[1]).toHaveTextContent("2");
    expect(rows[1].querySelectorAll("td")[2]).toHaveTextContent("1");
    expect(rows[2]).toHaveTextContent("zzz-not-in-catalog (billa)");
  });

  it("period presets and the test-traffic toggle change the metrics request", async () => {
    await renderAdmin();
    await login();
    await userEvent.click(screen.getByRole("button", { name: "7 дней" }));
    await openFilters();
    await userEvent.click(screen.getByLabelText(/Включить тестовый и автоматический трафик/));
    await waitFor(() => {
      const p = lastMetricsParams();
      expect(p.get("to")).toBe(todaySofia());
      expect(p.get("include_test")).toBe("true");
      expect(p.get("include_automated")).toBe("true");
      const days = (Date.parse(p.get("to") as string) - Date.parse(p.get("from") as string)) / 86_400_000;
      expect(days).toBe(6);
    });
  });

  it("filters are loaded from /api/admin/filters and sent with the backend parameter names", async () => {
    await renderAdmin();
    await login();
    await openFilters();
    await userEvent.selectOptions(screen.getByLabelText("Платформа"), "miniapp");
    await waitFor(() => expect(lastMetricsParams().get("platform")).toBe("miniapp"));
    await userEvent.selectOptions(screen.getByLabelText("Тип источника"), "utm");
    await userEvent.selectOptions(screen.getByLabelText("Источник"), "ig");
    await userEvent.selectOptions(screen.getByLabelText("Кампания"), "autumn");
    await userEvent.selectOptions(screen.getByLabelText("Язык"), "ru");
    await waitFor(() => {
      const p = lastMetricsParams();
      expect(p.get("source_kind")).toBe("utm");
      expect(p.get("source")).toBe("ig");
      expect(p.get("campaign")).toBe("autumn");
      expect(p.get("lang")).toBe("ru");
    });
  });

  it("lists users: Telegram profile fields, first source label, limit/offset pagination", async () => {
    await renderAdmin();
    await login();
    const usersRegion = screen.getByRole("region", { name: "Пользователи" });
    await within(usersRegion).findByText("@ann_lee");
    const rows = within(usersRegion).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("4242");
    expect(rows[1]).toHaveTextContent("Ann");
    expect(rows[1]).toHaveTextContent("Lee");
    expect(rows[1]).toHaveTextContent("telegram / spring");
    expect(rows[2]).toHaveTextContent("Анонимный");
    expect(rows[2]).toHaveTextContent("ig / autumn");
    expect(usersRegion).toHaveTextContent("Страница 1 из 1");
    const req = reqs.filter((r) => r.url.startsWith("/api/admin/users?")).pop() as Req;
    const p = new URL(req.url, "http://x").searchParams;
    expect(p.get("limit")).toBe("20");
    expect(p.get("offset")).toBe("0");
    expect(p.has("page")).toBe(false);
  });

  it("an unknown source is shown as 'Источник неизвестен'", async () => {
    anonUnknown = true;
    await renderAdmin();
    await login();
    const usersRegion = screen.getByRole("region", { name: "Пользователи" });
    await within(usersRegion).findByText("@ann_lee");
    expect(within(usersRegion).getAllByRole("row")[2]).toHaveTextContent("Источник неизвестен");
  });

  it("search is a POST with q in the JSON body, never in a URL", async () => {
    await renderAdmin();
    await login();
    await userEvent.type(screen.getByLabelText("Поиск пользователей"), "ann");
    await userEvent.click(screen.getByRole("button", { name: "Найти" }));
    await waitFor(() => {
      const req = reqs.filter((r) => r.url === "/api/admin/users/search").pop() as Req;
      expect(req.method).toBe("POST");
      const body = JSON.parse(req.init?.body as string);
      expect(body).toMatchObject({ q: "ann", limit: 20, offset: 0 });
      expect(body.from).toBeTruthy();
    });
    expect(reqs.some((r) => r.url.includes("q=ann"))).toBe(false);
  });
});

describe("admin dashboard v2", () => {
  it("default preset is 7 days, a chosen preset is remembered, Today/Yesterday send one-day ranges", async () => {
    await renderAdmin();
    await login();
    expect(screen.getByRole("button", { name: "7 дней" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Вчера" }));
    await waitFor(() => {
      const p = lastMetricsParams();
      expect(p.get("from")).toBe(p.get("to"));
      expect(p.get("to")).not.toBe(todaySofia());
    });
    expect(localStorage.getItem("bgp_admin_preset")).toBe("yesterday");
    await userEvent.click(screen.getByRole("button", { name: "Сегодня" }));
    await waitFor(() => {
      const p = lastMetricsParams();
      expect(p.get("from")).toBe(todaySofia());
      expect(p.get("to")).toBe(todaySofia());
    });
  });

  it("the initial range is computed from the Sofia date, not the browser/UTC date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-18T22:30:00Z"));
    try {
      await renderAdmin();
      await login();
      const first = reqs.find((r) => r.url.startsWith("/api/admin/metrics")) as Req;
      const p = new URL(first.url, "http://x").searchParams;
      expect(p.get("to")).toBe("2026-10-19");
      expect(p.get("from")).toBe("2026-10-13");
    } finally {
      vi.useRealTimers();
    }
  });

  it("custom period shows from/to inputs; filters collapse shows an active count", async () => {
    await renderAdmin();
    await login();
    expect(screen.queryByLabelText("С")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Период…" }));
    expect(screen.getByLabelText("С")).toBeInTheDocument();
    await openFilters();
    await userEvent.selectOptions(screen.getByLabelText("Платформа"), "miniapp");
    expect(screen.getByRole("button", { name: "Фильтры (1)" })).toBeInTheDocument();
  });

  it("chart draws both lines; day buckets get date labels, hour buckets get times", async () => {
    await renderAdmin();
    await login();
    const region = await screen.findByRole("region", { name: "Динамика" });
    expect(region.querySelector('path[data-series="current"]')).not.toBeNull();
    expect(region.querySelector('path[data-series="previous"]')).not.toBeNull();
    expect(region).toHaveTextContent("12.10");
    expect(region).toHaveTextContent("Текущий период");
    expect(region).toHaveTextContent("Прошлый период");
    await userEvent.click(region.querySelector('rect[data-hit="6"]') as Element);
    expect(within(region).getByRole("status")).toHaveTextContent("18.10: текущий 2 · прошлый (11.10) 0");
    cleanup();
    loggedIn = false;

    const hourly = structuredClone(METRICS) as typeof METRICS & { series: { bucket: string } };
    hourly.series.bucket = "hour";
    hourly.series.points = hourly.series.points.map((p, i) => ({ ...p, t: `2026-10-18T${String(10 + i).padStart(2, "0")}:00:00+03:00` }));
    metricsData = hourly;
    await renderAdmin();
    await login();
    const region2 = await screen.findByRole("region", { name: "Динамика" });
    expect(region2).toHaveTextContent("10:00");
  });

  it("funnel shows % of 'Открыли' and deltas, steps counted independently", async () => {
    await renderAdmin();
    await login();
    const funnel = await screen.findByRole("region", { name: "Воронка" });
    const rows = within(funnel).getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent("Открыли");
    expect(rows[0]).toHaveTextContent("100%");
    expect(rows[0]).toHaveTextContent("▲ 100% (было 1)");
    expect(rows[1]).toHaveTextContent("Каталог");
    expect(rows[1]).toHaveTextContent("50%");
    expect(rows[1]).toHaveTextContent("▲ новое (было 0)");
    expect(funnel).toHaveTextContent("Шаги считаются независимо");
  });

  it("platforms and sources tables; unknown source is labelled", async () => {
    await renderAdmin();
    await login();
    const platforms = await screen.findByRole("region", { name: "Платформы" });
    expect(platforms).toHaveTextContent("Mini App");
    expect(platforms).toHaveTextContent("▲ новое (было 0)");
    const sources = screen.getByRole("region", { name: "Источники" });
    expect(sources).toHaveTextContent("startapp / telegram / spring");
    expect(sources).toHaveTextContent("Источник неизвестен");
  });

  it("noise errors are collapsed by default and the main table has only real errors", async () => {
    const data = structuredClone(METRICS) as typeof METRICS;
    data.errors.push({ ...data.errors[0], name: "Error", message: "Script error.", source: "external", noise: true } as never);
    metricsData = data;
    await renderAdmin();
    await login();
    const region = await screen.findByRole("region", { name: "Ошибки" });
    expect(region).toHaveTextContent("TypeError: x is undefined");
    expect(region).not.toHaveTextContent("Script error.");
    const toggle = within(region).getByRole("button", { name: "Шум внешних скриптов (1)" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(region).toHaveTextContent("браузер скрывает их текст");
    await userEvent.click(toggle);
    expect(region).toHaveTextContent("Error: Script error.");
  });
});

describe("admin user card", () => {
  it("marks an inherited session source with (унаследован), an own one without", async () => {
    for (const inherited of [false, true]) {
      inheritedSession = inherited;
      await renderAdmin();
      await login();
      await userEvent.click(await screen.findByRole("button", { name: "4242" }));
      await screen.findByRole("region", { name: "Профиль" });
      const marked = screen.queryAllByText(/\(унаследован\)/);
      expect(marked.length > 0).toBe(inherited);
      cleanup();
      loggedIn = false;
    }
  });

  it("an anonymous visitor is explicitly marked as unidentified", async () => {
    anonUnknown = true;
    await renderAdmin();
    await login();
    await userEvent.click(await screen.findByRole("button", { name: "Анонимный" }));
    const profile = await screen.findByRole("region", { name: "Профиль" });
    expect(profile).toHaveTextContent("Личность неизвестна — анонимный посетитель сайта");
    expect(profile).toHaveTextContent("Источник неизвестен");
    expect(screen.getByRole("region", { name: "События" })).toHaveTextContent("site_open");
    expect(screen.getByRole("region", { name: "Сессии" })).toHaveTextContent("bg");
  });

  it("shows the Telegram profile for a Telegram user", async () => {
    await renderAdmin();
    await login();
    await userEvent.click(await screen.findByRole("button", { name: "4242" }));
    const profile = await screen.findByRole("region", { name: "Профиль" });
    expect(profile).toHaveTextContent("@ann_lee");
    expect(profile).not.toHaveTextContent("Личность неизвестна");
    expect(reqs.some((r) => r.method === "GET" && r.url === `/api/admin/users/${TG_ID}`)).toBe(true);
    expect(screen.getByRole("region", { name: "События" })).toHaveTextContent("cart_add");
  });

  it("deleting needs a confirmation: cancel keeps the user, confirm calls DELETE and returns to the list", async () => {
    await renderAdmin();
    await login();
    await userEvent.click(await screen.findByRole("button", { name: "Анонимный" }));
    await userEvent.click(await screen.findByRole("button", { name: "Удалить пользователя" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("необратимо");
    await userEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(reqs.filter((r) => r.method === "DELETE")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Удалить пользователя" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(reqs.filter((r) => r.method === "DELETE")).toHaveLength(1));
    expect(reqs.find((r) => r.method === "DELETE")?.url).toBe(`/api/admin/users/${ANON_ID}`);
    expect(await screen.findByRole("region", { name: "Показатели" })).toBeInTheDocument();
  });
});
