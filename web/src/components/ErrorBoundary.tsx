import { Component, type ErrorInfo, type ReactNode } from "react";
import { isLang, translate } from "../i18n";
import { reportAppError } from "../platform/analytics";
import { getLang, reloadPage } from "../platform/document";
import { session } from "../platform/session";
import styles from "./ErrorBoundary.module.css";

const CHUNK_MESSAGE = /Failed to fetch dynamically imported module|Importing a module script failed/;
const RELOAD_FLAG = "chunkReloadAt";
const RELOAD_GUARD_MS = 60_000;

/** A lazy chunk that no longer exists (new deploy) or could not be fetched. */
export function isChunkLoadError(error: unknown): boolean {
  const e = error as { name?: string; message?: string } | null;
  return !!e && (e.name === "ChunkLoadError" || CHUNK_MESSAGE.test(e.message ?? ""));
}

/**
 * Reloads the page once per minute for a chunk-load error (the SW then serves the new build).
 * Returns true when a reload was triggered.
 */
export function reloadOnceForChunkError(error: unknown, now: number = Date.now()): boolean {
  if (!isChunkLoadError(error)) return false;
  const last = Number(session.get(RELOAD_FLAG) ?? 0);
  if (last && now - last < RELOAD_GUARD_MS) return false;
  session.set(RELOAD_FLAG, String(now));
  reloadPage();
  return true;
}

interface Props {
  children: ReactNode;
  /** Changing this value (e.g. the pathname) clears a shown error. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

/** Friendly fallback instead of a white screen; works outside LangProvider. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Technical description (message, stack, component stack) goes to the internal analytics only.
    reportAppError(error, "boundary", info.componentStack ?? undefined);
    reloadOnceForChunkError(error);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const docLang = getLang();
    const lang = isLang(docLang) ? docLang : "bg";
    return (
      <div className={styles.box} role="alert">
        <h2 className={styles.title}>{translate(lang, "error.title")}</h2>
        <p>{translate(lang, "error.text")}</p>
        <button type="button" className={styles.btn} onClick={reloadPage}>
          {translate(lang, "error.reload")}
        </button>
      </div>
    );
  }
}
