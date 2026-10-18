import { apiUrl } from "./api";

/**
 * Client of /api/admin/* (docs/ANALYTICS.md). Only the signed HttpOnly `bgp_admin` cookie authenticates:
 * requests are same-origin with credentials; nothing is kept in JS-accessible storage.
 * Responses are normalised defensively (missing numbers -> 0, missing lists -> []).
 */

/** The session is missing or expired (HTTP 401): show the login form. */
export class AdminAuthError extends Error {
  constructor() {
    super("admin: unauthorized");
    this.name = "AdminAuthError";
  }
}

export class AdminHttpError extends Error {
  constructor(public status: number) {
    super(`admin: HTTP ${status}`);
    this.name = "AdminHttpError";
  }
}

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(apiUrl(path), {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw new AdminAuthError();
  if (!res.ok) throw new AdminHttpError(res.status);
  if (res.status === 204) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export type LoginOutcome = "ok" | "bad_password" | "rate_limited" | "disabled" | "error";

/** POST /api/admin/login {password}. */
export async function adminLogin(password: string): Promise<LoginOutcome> {
  try {
    await request("POST", "/api/admin/login", { password });
    return "ok";
  } catch (e) {
    if (e instanceof AdminAuthError) return "bad_password";
    if (e instanceof AdminHttpError) {
      if (e.status === 429) return "rate_limited";
      if (e.status === 503 || e.status === 404) return "disabled";
    }
    return "error";
  }
}

export async function adminLogout(): Promise<void> {
  try {
    await request("POST", "/api/admin/logout");
  } catch {
    /* the cookie expires anyway */
  }
}

export interface AdminFilterOptions {
  platforms: string[];
  langs: string[];
  sourceKinds: string[];
  sources: string[];
  campaigns: string[];
}

const strings = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string" && x !== "");

/** GET /api/admin/filters -> {platforms, langs, source_kinds, sources, campaigns}: string lists. */
export async function getFilters(): Promise<AdminFilterOptions> {
  const d = obj(await request("GET", "/api/admin/filters"));
  return {
    platforms: strings(d.platforms),
    langs: strings(d.langs),
    sourceKinds: strings(d.source_kinds),
    sources: strings(d.sources),
    campaigns: strings(d.campaigns),
  };
}

export interface AdminQuery {
  from: string;
  to: string;
  platform: string;
  lang: string;
  sourceKind: string;
  source: string;
  campaign: string;
  /** One UI toggle: sends both include_test and include_automated. */
  includeTest: boolean;
}

function queryString(q: AdminQuery, extra: Record<string, string | number> = {}): string {
  const p = new URLSearchParams();
  p.set("from", q.from);
  p.set("to", q.to);
  if (q.platform) p.set("platform", q.platform);
  if (q.lang) p.set("lang", q.lang);
  if (q.sourceKind) p.set("source_kind", q.sourceKind);
  if (q.source) p.set("source", q.source);
  if (q.campaign) p.set("campaign", q.campaign);
  if (q.includeTest) {
    p.set("include_test", "true");
    p.set("include_automated", "true");
  }
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  return p.toString();
}

export interface Kpi {
  users: number;
  usersTg: number;
  usersAnon: number;
  sessions: number;
  botStarts: number;
  miniappOpens: number;
  siteOpens: number;
  catalogLoads: number;
  cartAddUsers: number;
  shareLinks: number;
  importsOk: number;
  returning: number;
}

export interface Metrics {
  kpi: Kpi;
  topOffers: { offerId: string; chain: string | null; views: number; adds: number }[];
  zeroQueries: { query: string; count: number }[];
  errors: AdminError[];
}

/** One group of app_error events (same name/where/message/source/file/line). Legacy rows lack the details. */
export interface AdminError {
  name: string;
  where: string;
  message: string | null;
  source: string | null;
  file: string | null;
  line: number | null;
  col: number | null;
  count: number;
  lastSeen: string | null;
  stack: string | null;
  path: string | null;
}

/** Merges the two backend top lists (viewed / carted, {offer_id, chain, category, count}) by offer. */
function mergeTop(d: Record<string, unknown>): Metrics["topOffers"] {
  const map = new Map<string, Metrics["topOffers"][number]>();
  const add = (list: unknown, field: "views" | "adds") => {
    for (const x of arr(list)) {
      const o = obj(x);
      const offerId = str(o.offer_id);
      if (!offerId) continue;
      const key = `${str(o.chain) ?? ""}|${offerId}`;
      const row = map.get(key) ?? { offerId, chain: str(o.chain), views: 0, adds: 0 };
      row[field] += num(o.count);
      map.set(key, row);
    }
  };
  add(d.viewed, "views");
  add(d.carted, "adds");
  return [...map.values()].sort((a, b) => b.views + b.adds - (a.views + a.adds));
}

/**
 * GET /api/admin/metrics?from&to&platform&lang&source_kind&source&campaign&include_test&include_automated.
 * Response: {period, users:{total,tg,anon}, sessions, bot_starts, miniapp_opens, site_opens,
 * catalog_loads, cart_add_users, share_links, imports_successful, returning_visitors,
 * top_offers:{viewed[],carted[]}, zero_result_queries[], errors[]}.
 */
export async function getMetrics(q: AdminQuery): Promise<Metrics> {
  const d = obj(await request("GET", `/api/admin/metrics?${queryString(q)}`));
  const u = obj(d.users);
  return {
    kpi: {
      users: num(u.total),
      usersTg: num(u.tg),
      usersAnon: num(u.anon),
      sessions: num(d.sessions),
      botStarts: num(d.bot_starts),
      miniappOpens: num(d.miniapp_opens),
      siteOpens: num(d.site_opens),
      catalogLoads: num(d.catalog_loads),
      cartAddUsers: num(d.cart_add_users),
      shareLinks: num(d.share_links),
      importsOk: num(d.imports_successful),
      returning: num(d.returning_visitors),
    },
    topOffers: mergeTop(obj(d.top_offers)),
    zeroQueries: arr(d.zero_result_queries).map((x) => {
      const o = obj(x);
      return { query: str(o.query) ?? "", count: num(o.count) };
    }),
    errors: arr(d.errors).map((x) => {
      const o = obj(x);
      return {
        name: str(o.name) ?? "",
        where: str(o.where) ?? "",
        message: str(o.message),
        source: str(o.source),
        file: str(o.file),
        line: typeof o.line === "number" ? o.line : null,
        col: typeof o.col === "number" ? o.col : null,
        count: num(o.count),
        lastSeen: str(o.last_seen),
        stack: str(o.stack),
        path: str(o.path),
      };
    }),
  };
}

export interface AdminUser {
  id: string;
  kind: "tg" | "anon";
  tgId: number | null;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  language: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  /** Human-readable first source, null when unknown. */
  firstSource: string | null;
  sessions: number;
  cartAdds: number;
}

/** Source object {kind, source, medium, campaign, placement} (nullable parts) -> readable label or null. */
function sourceLabel(v: unknown): string | null {
  const o = obj(v);
  if (!Object.keys(o).length || o.kind === "unknown") return null;
  const parts = [str(o.source), str(o.campaign), str(o.placement)].filter((x): x is string => x !== null);
  return parts.length ? parts.join(" / ") : str(o.kind);
}

function toUser(x: unknown): AdminUser {
  const o = obj(x);
  const tgId = typeof o.tg_id === "number" ? o.tg_id : null;
  const kind = o.kind === "tg" && o.is_anonymous !== true ? "tg" : "anon";
  return {
    id: str(o.visitor_id) ?? "",
    kind,
    tgId,
    username: str(o.username),
    firstName: str(o.first_name),
    lastName: str(o.last_name),
    language: str(o.language),
    firstSeen: str(o.first_seen),
    lastSeen: str(o.last_seen),
    firstSource: sourceLabel(o.first_source),
    sessions: num(o.sessions),
    cartAdds: num(o.cart_adds),
  };
}

export const USERS_PAGE_SIZE = 20;

export interface UsersPage {
  total: number;
  items: AdminUser[];
}

/** JSON body of POST /api/admin/users/search: same filters as the query string, plus q. */
function searchBody(q: AdminQuery, search: string, limit: number, offset: number): Record<string, unknown> {
  const b: Record<string, unknown> = { q: search, from: q.from, to: q.to, limit, offset };
  if (q.platform) b.platform = q.platform;
  if (q.lang) b.lang = q.lang;
  if (q.sourceKind) b.source_kind = q.sourceKind;
  if (q.source) b.source = q.source;
  if (q.campaign) b.campaign = q.campaign;
  if (q.includeTest) {
    b.include_test = true;
    b.include_automated = true;
  }
  return b;
}

/**
 * Without search text: GET /api/admin/users?...&limit&offset. With search text: POST
 * /api/admin/users/search (JSON body) so that personal search terms never reach URLs or access
 * logs. Both -> {total, limit, offset, items[]}; page is 1-based.
 */
export async function getUsers(q: AdminQuery, search: string, page: number): Promise<UsersPage> {
  const limit = USERS_PAGE_SIZE;
  const offset = Math.max(0, page - 1) * USERS_PAGE_SIZE;
  const text = search.trim();
  const d = obj(
    text
      ? await request("POST", "/api/admin/users/search", searchBody(q, text, limit, offset))
      : await request("GET", `/api/admin/users?${queryString(q, { limit, offset })}`),
  );
  const items = arr(d.items).map(toUser);
  return { total: num(d.total), items };
}

export interface UserCard {
  user: AdminUser;
  sessions: { id: string; platform: string; startedAt: string | null; source: string | null; lang: string | null }[];
  events: { ts: string | null; name: string; platform: string | null; props: string }[];
}

/**
 * GET /api/admin/users/<id> -> flat profile {visitor_id, kind, is_anonymous, tg_id, username, ...,
 * first_source, is_test} plus sessions[{session_id, ...}] and events[] (newest first, capped).
 * `sessions` / `cartAdds` of the profile are derived from the returned lists.
 */
export async function getUser(id: string): Promise<UserCard> {
  const d = obj(await request("GET", `/api/admin/users/${encodeURIComponent(id)}`));
  const sessionList = arr(d.sessions);
  const eventList = arr(d.events);
  const user = toUser(d);
  user.sessions = sessionList.length;
  user.cartAdds = eventList.filter((e) => obj(e).name === "cart_add").length;
  return {
    user,
    sessions: sessionList.map((x) => {
      const o = obj(x);
      return {
        id: str(o.session_id) ?? "",
        platform: str(o.platform) ?? "",
        startedAt: str(o.started_at),
        source: sourceLabel(o.source),
        lang: str(o.lang),
      };
    }),
    events: eventList.map((x) => {
      const o = obj(x);
      const props = obj(o.props);
      return {
        ts: str(o.ts),
        name: str(o.name) ?? "",
        platform: str(o.platform),
        props: Object.keys(props).length ? JSON.stringify(props) : "",
      };
    }),
  };
}

/** DELETE /api/admin/users/<id>: removes the visitor, sessions and events. */
export async function deleteUser(id: string): Promise<void> {
  await request("DELETE", `/api/admin/users/${encodeURIComponent(id)}`);
}
