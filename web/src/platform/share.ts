export interface ShareData {
  title: string;
  url: string;
  /** Optional message passed to the native share sheet (the copy fallback copies only the url). */
  text?: string;
}

export type ShareResult = "shared" | "copied" | "failed";

export interface Sharer {
  share(data: ShareData): Promise<ShareResult>;
}

/** navigator.share, falling back to copying the link. */
export const webSharer: Sharer = {
  async share(data) {
    try {
      if (typeof navigator.share === "function") {
        await navigator.share(
          data.text ? { title: data.title, text: data.text, url: data.url } : { title: data.title, url: data.url },
        );
        return "shared";
      }
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return "failed";
    }
    try {
      await navigator.clipboard.writeText(data.url);
      return "copied";
    } catch {
      return "failed";
    }
  },
};

/** True when the native share sheet exists (absent in many Telegram webviews). */
export function canNativeShare(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

/**
 * Copy text: async Clipboard API first, then the legacy execCommand path, which still works in
 * webviews (Telegram Mini App) where the Clipboard API is missing or denied. Never throws.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Telegram's own "forward to a chat" page; opens the chat picker inside Telegram. */
export function telegramShareUrl(url: string, text: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}

let sharer: Sharer = webSharer;

export function setSharer(s: Sharer): void {
  sharer = s;
}

export function share(data: ShareData): Promise<ShareResult> {
  return sharer.share(data);
}
