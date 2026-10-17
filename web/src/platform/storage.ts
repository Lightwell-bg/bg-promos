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

/** The IndexedDB operations used by the storage (injectable for tests). */
export interface IdbOps {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

const defaultOps: IdbOps = {
  get: (k) => idbGet(k),
  set: (k, v) => idbSet(k, v),
  del: (k) => idbDel(k),
};

/** After an IDB error, the next attempt is made once this much time has passed. */
export const IDB_RETRY_COOLDOWN_MS = 30_000;

/**
 * IndexedDB (idb-keyval) mirrored into memory. Successful reads and writes are copied to
 * the memory map; after an IDB error the mirror keeps serving values, and IDB is retried
 * on the first operation after the cooldown (the failure is not permanent).
 */
export function createIdbStorage(
  ops: IdbOps = defaultOps,
  now: () => number = Date.now,
  cooldownMs: number = IDB_RETRY_COOLDOWN_MS,
): KeyValueStorage {
  const memory = createMemoryStorage();
  const unavailable = typeof indexedDB === "undefined" && ops === defaultOps;
  let failedAt: number | null = null;

  /** IDB may be tried: it never failed, or the cooldown after the last failure has passed. */
  const usable = (): boolean => {
    if (unavailable) return false;
    return failedAt === null || now() - failedAt >= cooldownMs;
  };
  const fail = (): void => {
    failedAt = now();
  };

  return {
    async get<T>(key: string) {
      if (usable()) {
        try {
          const v = await ops.get<T>(key);
          failedAt = null;
          if (v !== undefined) {
            await memory.set(key, v);
            return v;
          }
        } catch {
          fail();
        }
      }
      return memory.get<T>(key);
    },
    async set<T>(key: string, value: T) {
      await memory.set(key, value);
      if (usable()) {
        try {
          await ops.set(key, value);
          failedAt = null;
        } catch {
          fail();
        }
      }
    },
    async del(key: string) {
      await memory.del(key);
      if (usable()) {
        try {
          await ops.del(key);
          failedAt = null;
        } catch {
          fail();
        }
      }
    },
  };
}

export const storage: KeyValueStorage = createIdbStorage();
