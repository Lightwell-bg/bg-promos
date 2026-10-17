export interface ShareData {
  title: string;
  url: string;
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
        await navigator.share({ title: data.title, url: data.url });
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

let sharer: Sharer = webSharer;

export function setSharer(s: Sharer): void {
  sharer = s;
}

export function share(data: ShareData): Promise<ShareResult> {
  return sharer.share(data);
}
