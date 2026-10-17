import type { Catalog } from "../domain/types";
import type { KeyValueStorage } from "../platform/storage";
import { apiUrl } from "./api";

export type CatalogStatus = "loading" | "ready" | "offline" | "error";

export interface CatalogState {
  status: CatalogStatus;
  catalog: Catalog | null;
  etag: string | null;
  /** ms epoch of the last successful server check (200 or 304). */
  lastCheckedAt: number | null;
  /** Last fetch problem that did not make the app unusable (HTTP error with cache). */
  error: string | null;
}

interface Cached {
  catalog: Catalog;
  etag: string | null;
  checkedAt: number | null;
}

export const CATALOG_KEY = "catalog:v1";
export const REFRESH_THROTTLE_MS = 60_000;

export interface CatalogStoreDeps {
  storage: KeyValueStorage;
  fetchFn?: typeof fetch;
  now?: () => number;
  apiBase?: string;
  /** How long init() waits for the cached copy before going to the network. Default 800 ms. */
  cacheTimeoutMs?: number;
  /** Network timeout of the catalog request. Default 15 s. */
  fetchTimeoutMs?: number;
}

export const CACHE_READ_TIMEOUT_MS = 800;
export const FETCH_TIMEOUT_MS = 15_000;

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
}

function isCatalog(x: unknown): x is Catalog {
  const c = x as Catalog | null;
  return !!c && typeof c === "object" && Array.isArray(c.offers) && Array.isArray(c.categories) && !!c.chains;
}

/** Cache-first catalog loader with ETag revalidation. Framework-agnostic. */
export class CatalogStore {
  private state: CatalogState = {
    status: "loading",
    catalog: null,
    etag: null,
    lastCheckedAt: null,
    error: null,
  };
  private listeners = new Set<() => void>();
  private inflight: Promise<void> | null = null;
  private lastAttemptAt = -Infinity;
  private readonly storage: KeyValueStorage;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly base: string;
  private readonly cacheTimeoutMs: number;
  private readonly fetchTimeoutMs: number;
  /** Bumped whenever a network answer is applied; a cache read from before it must not win. */
  private generation = 0;

  constructor(deps: CatalogStoreDeps) {
    this.storage = deps.storage;
    this.fetchFn = deps.fetchFn ?? ((...a) => fetch(...a));
    this.now = deps.now ?? (() => Date.now());
    this.base = deps.apiBase ?? "";
    this.cacheTimeoutMs = deps.cacheTimeoutMs ?? CACHE_READ_TIMEOUT_MS;
    this.fetchTimeoutMs = deps.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  }

  getSnapshot = (): CatalogState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<CatalogState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  /**
   * Loads the cached copy (renders immediately), then revalidates. The cache read is raced
   * against a timeout so a stuck IndexedDB never blocks the network; a late cache result is
   * applied only if no fresher catalog has been set in the meantime.
   */
  async init(): Promise<void> {
    const startGeneration = this.generation;
    const read = this.storage
      .get<Cached>(CATALOG_KEY)
      .then((cached) => {
        this.applyCached(cached, startGeneration);
      })
      .catch(() => {
        /* unreadable cache = no cache */
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.cacheTimeoutMs);
    });
    try {
      await Promise.race([read, timeout]);
    } finally {
      clearTimeout(timer);
    }
    await this.refresh({ force: true });
  }

  private applyCached(cached: Cached | undefined, startGeneration: number) {
    if (!cached || !isCatalog(cached.catalog)) return;
    // A network answer (or any catalog) that arrived first is always fresher than the cache.
    if (this.generation !== startGeneration || this.state.catalog) return;
    this.set({
      status: "ready",
      catalog: cached.catalog,
      etag: cached.etag ?? null,
      lastCheckedAt: cached.checkedAt ?? null,
    });
  }

  /** Revalidates; throttled to once per 60 s unless `force`. */
  refresh(opts: { force?: boolean } = {}): Promise<void> {
    if (this.inflight) return this.inflight;
    const t = this.now();
    if (!opts.force && t - this.lastAttemptAt < REFRESH_THROTTLE_MS) return Promise.resolve();
    this.lastAttemptAt = t;
    this.inflight = this.doFetch().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doFetch(): Promise<void> {
    const { catalog: cached, etag } = this.state;
    const headers: Record<string, string> = {};
    if (cached && etag) headers["If-None-Match"] = etag;
    try {
      const res = await this.fetchFn(apiUrl("/api/v1/catalog", this.base), {
        headers,
        signal: timeoutSignal(this.fetchTimeoutMs),
      });
      if (res.status === 304 && cached) {
        const checkedAt = this.now();
        this.generation++;
        this.set({ status: "ready", lastCheckedAt: checkedAt, error: null });
        await this.persist(cached, etag, checkedAt);
        return;
      }
      if (!res.ok) throw new HttpError(res.status);
      let data: unknown;
      try {
        data = await res.json();
      } catch (e) {
        // A broken body is a server problem (status error), not "offline"; timeouts stay network errors.
        if (e instanceof SyntaxError) throw new HttpError(502);
        throw e;
      }
      if (!isCatalog(data)) throw new HttpError(502);
      const newEtag = res.headers.get("ETag");
      const checkedAt = this.now();
      this.generation++;
      this.set({ status: "ready", catalog: data, etag: newEtag, lastCheckedAt: checkedAt, error: null });
      await this.persist(data, newEtag, checkedAt);
    } catch (e) {
      if (e instanceof HttpError) {
        // Server answered badly: keep showing the cache but tell the user.
        this.set({ status: cached ? "ready" : "error", error: `HTTP ${e.status}` });
      } else {
        // Network failure: cached data means "offline", otherwise a real error.
        this.set({ status: cached ? "offline" : "error", error: cached ? null : "network" });
      }
    }
  }

  private async persist(catalog: Catalog, etag: string | null, checkedAt: number) {
    try {
      await this.storage.set<Cached>(CATALOG_KEY, { catalog, etag, checkedAt });
    } catch {
      /* cache is best-effort */
    }
  }
}

class HttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}
