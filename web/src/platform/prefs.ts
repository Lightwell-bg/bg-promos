import { storage as defaultStorage, type KeyValueStorage } from "./storage";

const PREFIX = "pref:";

/** Small values on top of the KV storage, cached in memory for synchronous reads. */
export class Prefs {
  private cache = new Map<string, unknown>();
  /** Bumped on every set/remove of a key; a preload result is stale if it changed meanwhile. */
  private versions = new Map<string, number>();
  private listeners = new Set<() => void>();
  constructor(private kv: KeyValueStorage) {}

  private bump(key: string): void {
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }

  /** Subscribes to late preload results. Returns an unsubscribe function. */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    this.listeners.forEach((l) => l());
  }

  /**
   * Loads the given keys into the cache. A value read from storage is applied only if
   * the key was not set/removed after the preload started; subscribers are notified
   * when something was applied (a preload that finishes late still updates the UI).
   */
  async preload(keys: readonly string[]): Promise<void> {
    await Promise.all(
      keys.map(async (k) => {
        const started = this.versions.get(k) ?? 0;
        try {
          const v = await this.kv.get<unknown>(PREFIX + k);
          if (v === undefined || (this.versions.get(k) ?? 0) !== started) return;
          this.cache.set(k, v);
          this.notify();
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
    this.bump(key);
    this.cache.set(key, value);
    void this.kv.set(PREFIX + key, value).catch(() => undefined);
  }

  remove(key: string): void {
    this.bump(key);
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
