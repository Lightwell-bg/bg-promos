/** Minimal shape of navigator.locks that we use. */
export interface LockManagerLike {
  request<T>(name: string, cb: () => T | Promise<T>): Promise<T>;
}

let override: LockManagerLike | null | undefined;

/** Test hook: replace the lock manager (null = locks unavailable, undefined = use navigator.locks). */
export function setLockManager(m: LockManagerLike | null | undefined): void {
  override = m;
}

function manager(): LockManagerLike | null {
  if (override !== undefined) return override;
  try {
    const l = typeof navigator !== "undefined" ? (navigator as { locks?: LockManagerLike }).locks : undefined;
    return l && typeof l.request === "function" ? l : null;
  } catch {
    return null;
  }
}

/**
 * Runs `fn` exclusively across tabs (Web Locks). Without locks `fn` runs immediately
 * (synchronously) and its result is wrapped in a resolved promise.
 */
export function withLock<T>(name: string, fn: () => T): Promise<T> {
  const m = manager();
  if (!m) {
    try {
      return Promise.resolve(fn());
    } catch (e) {
      return Promise.reject(e);
    }
  }
  return m.request(name, () => fn());
}
