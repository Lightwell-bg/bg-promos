/** Calls `cb` when Escape is pressed (closing dialogs). Returns an unsubscribe function. */
export function onEscape(cb: () => void): () => void {
  const handler = (e: KeyboardEvent) => {
    if (e.key === "Escape") cb();
  };
  document.addEventListener("keydown", handler);
  return () => document.removeEventListener("keydown", handler);
}

/**
 * Calls `cb` when the app returns to the foreground (visibilitychange -> visible)
 * or the network comes back ("online"). Returns an unsubscribe function.
 */
export function onForeground(cb: () => void): () => void {
  const onVisible = () => {
    if (document.visibilityState === "visible") cb();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", cb);
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", cb);
  };
}
