import { del as idbDel, get as idbGet, set as idbSet } from "idb-keyval";

/** Async key-value storage. Swap the implementation for a native shell. */
export interface KeyValueStorage {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
}

export function createMemoryStorage(): KeyValueStorage {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return map.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T) {
      map.set(key, value);
    },
    async del(key: string) {
      map.delete(key);
    },
  };
}

/** IndexedDB (idb-keyval) with an in-memory fallback when IDB is unavailable or fails. */
export function createIdbStorage(): KeyValueStorage {
  const memory = createMemoryStorage();
  let broken = typeof indexedDB === "undefined";
  return {
    async get<T>(key: string) {
      if (!broken) {
        try {
          const v = await idbGet<T>(key);
          if (v !== undefined) return v;
        } catch {
          broken = true;
        }
      }
      return memory.get<T>(key);
    },
    async set<T>(key: string, value: T) {
      await memory.set(key, value);
      if (!broken) {
        try {
          await idbSet(key, value);
        } catch {
          broken = true;
        }
      }
    },
    async del(key: string) {
      await memory.del(key);
      if (!broken) {
        try {
          await idbDel(key);
        } catch {
          broken = true;
        }
      }
    },
  };
}

export const storage: KeyValueStorage = createIdbStorage();
