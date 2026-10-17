import { storage as defaultStorage, type KeyValueStorage } from "./storage";

const PREFIX = "pref:";

/** Small values on top of the KV storage, cached in memory for synchronous reads. */
export class Prefs {
  private cache = new Map<string, unknown>();
  constructor(private kv: KeyValueStorage) {}

  /** Loads the given keys into the cache. Call once before first render. */
  async preload(keys: readonly string[]): Promise<void> {
    await Promise.all(
      keys.map(async (k) => {
        try {
          const v = await this.kv.get<unknown>(PREFIX + k);
          if (v !== undefined) this.cache.set(k, v);
        } catch {
          /* ignore */
        }
      }),
    );
  }

  get<T>(key: string, fallback: T): T {
    return this.cache.has(key) ? (this.cache.get(key) as T) : fallback;
  }

  set<T>(key: string, value: T): void {
    this.cache.set(key, value);
    void this.kv.set(PREFIX + key, value).catch(() => undefined);
  }

  remove(key: string): void {
    this.cache.delete(key);
    void this.kv.del(PREFIX + key).catch(() => undefined);
  }
}

export const PREF_KEYS = [
  "lang",
  "chain",
  "recentQueries",
  "visits",
  "installDismissedAt",
  "config",
  "consent",
] as const;

export const prefs = new Prefs(defaultStorage);
