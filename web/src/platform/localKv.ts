/**
 * Small synchronous JSON key-value store over window.localStorage.
 * - Business code never touches localStorage; a native shell swaps this adapter.
 * - Reads always hit the storage (another tab may have changed the value); writes are
 *   immediate, so read-modify-write sequences never act on a stale copy.
 * - When localStorage throws (private mode, Telegram webviews, quota) the values live in
 *   memory only: the app keeps working, the data just is not persisted.
 * - Changes made in another tab ("storage" event) are delivered to subscribers.
 */
export interface LocalKv {
  /** Latest stored value (fresh read); undefined when absent or unreadable. */
  get<T>(key: string): T | undefined;
  /** Writes right away (and keeps an in-memory copy if the storage refuses). */
  set(key: string, value: unknown): void;
  remove(key: string): void;
  /** Calls `cb` with the new value (undefined = removed) when another tab changes the key. */
  subscribe(key: string, cb: (value: unknown) => void): () => void;
}

export interface LocalKvOptions {
  /** Returns the Storage; may throw. Default: window.localStorage. */
  getStorage?: () => Storage;
}

export function createLocalKv(opts: LocalKvOptions = {}): LocalKv {
  const getStorage = opts.getStorage ?? (() => window.localStorage);
  const cache = new Map<string, unknown>();
  /** Keys whose last write could not reach the storage: the memory copy is authoritative. */
  const memoryOnly = new Set<string>();
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  let attached = false;

  function parse(raw: string | null): unknown {
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  function emit(key: string, value: unknown): void {
    listeners.get(key)?.forEach((cb) => cb(value));
  }

  function onStorage(e: StorageEvent): void {
    if (e.key === null) {
      // localStorage.clear() in another tab.
      cache.clear();
      memoryOnly.clear();
      for (const key of Array.from(listeners.keys())) emit(key, undefined);
      return;
    }
    if (!listeners.has(e.key) && !cache.has(e.key)) return;
    const value = parse(e.newValue);
    memoryOnly.delete(e.key);
    if (value === undefined) cache.delete(e.key);
    else cache.set(e.key, value);
    emit(e.key, value);
  }

  function attach(): void {
    if (attached || typeof window === "undefined") return;
    attached = true;
    window.addEventListener("storage", onStorage);
  }

  return {
    get<T>(key: string): T | undefined {
      let raw: string | null;
      try {
        raw = getStorage().getItem(key);
      } catch {
        return cache.get(key) as T | undefined; // storage unavailable: memory copy
      }
      if (raw === null) {
        if (memoryOnly.has(key)) return cache.get(key) as T | undefined;
        cache.delete(key);
        return undefined;
      }
      const value = parse(raw);
      if (value === undefined) cache.delete(key);
      else cache.set(key, value);
      return value as T | undefined;
    },
    set(key, value) {
      attach();
      cache.set(key, value);
      try {
        getStorage().setItem(key, JSON.stringify(value));
        memoryOnly.delete(key);
      } catch {
        memoryOnly.add(key); // storage unavailable or full: the in-memory copy keeps serving
      }
    },
    remove(key) {
      cache.delete(key);
      memoryOnly.delete(key);
      try {
        getStorage().removeItem(key);
      } catch {
        /* ignore */
      }
    },
    subscribe(key, cb) {
      attach();
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(cb);
      return () => {
        set.delete(cb);
        if (set.size === 0) listeners.delete(key);
      };
    },
  };
}

/** The app-wide instance. */
export const localKv: LocalKv = createLocalKv();
