import type { ReactNode } from "react";
import styles from "./EmptyState.module.css";

interface Props {
  /** Emoji shown inside the illustration. */
  icon?: string;
  text: string;
  children?: ReactNode;
}

/** Friendly empty state: a soft SVG blob behind an emoji, a sentence and an optional action. */
export function EmptyState({ icon = "🛒", text, children }: Props) {
  return (
    <div className={styles.root}>
      <div className={styles.art} aria-hidden="true">
        <svg viewBox="0 0 120 120" width="120" height="120" focusable="false">
          <defs>
            <linearGradient id="empty-blob" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#E6F3F4" />
              <stop offset="1" stopColor="#BFE6EA" />
            </linearGradient>
          </defs>
          <path
            d="M60 8c22 0 46 14 50 38s-8 54-34 62-58-4-66-30S14 22 36 12c8-3 16-4 24-4z"
            fill="url(#empty-blob)"
          />
          <circle cx="98" cy="22" r="7" fill="#FF6B35" opacity="0.85" />
          <circle cx="16" cy="94" r="5" fill="#087F8C" opacity="0.35" />
        </svg>
        <span className={styles.emoji}>{icon}</span>
      </div>
      <p className={styles.text}>{text}</p>
      {children}
    </div>
  );
}
