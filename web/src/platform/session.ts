/**
 * Per-tab session flags (survive a page reload, not a new tab). Falls back to memory
 * when sessionStorage is unavailable (private mode, native shells).
 */
const memory = new Map<string, string>();

export const session = {
  get(key: string): string | null {
    try {
      const v = window.sessionStorage.getItem(key);
      if (v !== null) return v;
    } catch {
      /* fall through to memory */
    }
    return memory.get(key) ?? null;
  },
  set(key: string, value: string): void {
    memory.set(key, value);
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      /* memory only */
    }
  },
  remove(key: string): void {
    memory.delete(key);
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};
