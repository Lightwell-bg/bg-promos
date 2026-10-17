import { useSyncExternalStore } from "react";
import { prefs } from "./prefs";

export type ConsentChoice = "granted" | "denied";
export interface ConsentRecord {
  choice: ConsentChoice;
  /** Epoch ms when the choice was made. */
  at: number;
}

/** The choice is asked again after 12 months. */
export const CONSENT_TTL_MS = 365 * 86_400_000;
const PREF = "consent";

/** Reads the stored choice; null when missing, malformed or older than 12 months. */
export function readConsent(now: number = Date.now()): ConsentRecord | null {
  const v = prefs.get<unknown>(PREF, null);
  if (!v || typeof v !== "object") return null;
  const { choice, at } = v as Partial<ConsentRecord>;
  if (choice !== "granted" && choice !== "denied") return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (now - at > CONSENT_TTL_MS) return null;
  return { choice, at };
}

const listeners = new Set<() => void>();
let snapshot: ConsentRecord | null | undefined;

function getSnapshot(): ConsentRecord | null {
  if (snapshot === undefined) snapshot = readConsent();
  return snapshot;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Stores the choice with a timestamp (platform storage) and notifies subscribers. */
export function saveConsent(choice: ConsentChoice, now: number = Date.now()): void {
  prefs.set(PREF, { choice, at: now });
  snapshot = readConsent(now);
  listeners.forEach((l) => l());
}

/** Drops the cached snapshot (tests, or after the prefs cache was reloaded). */
export function resetConsentCache(): void {
  snapshot = undefined;
  listeners.forEach((l) => l());
}

export function useConsent(): ConsentRecord | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}
