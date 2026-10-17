import type { AppConfig, ReportRequest } from "../domain/types";

/** Absolute base for native shells; empty = same origin (Vite proxy in dev). */
export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export function apiUrl(path: string, base: string = API_BASE): string {
  return `${base}${path}`;
}

export async function fetchConfig(fetchFn: typeof fetch = fetch): Promise<AppConfig> {
  const res = await fetchFn(apiUrl("/api/v1/config"));
  if (!res.ok) throw new Error(`config ${res.status}`);
  return (await res.json()) as AppConfig;
}

export type ReportOutcome = "ok" | "rate_limited" | "unavailable" | "invalid" | "error";

export async function postReport(
  body: ReportRequest,
  fetchFn: typeof fetch = fetch,
): Promise<ReportOutcome> {
  try {
    const res = await fetchFn(apiUrl("/api/v1/report"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return "ok";
    if (res.status === 429) return "rate_limited";
    if (res.status === 503) return "unavailable";
    if (res.status === 400) return "invalid";
    return "error";
  } catch {
    return "error";
  }
}
