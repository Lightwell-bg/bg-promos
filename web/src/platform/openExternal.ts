export interface ExternalOpener {
  open(url: string): void;
}

/** True only for absolute http(s) URLs: blocks javascript:, data:, file: and relative values. */
export function isSafeExternalUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Web implementation; a Capacitor shell would use the Browser plugin. */
export const webOpener: ExternalOpener = {
  open(url) {
    window.open(url, "_blank", "noopener,noreferrer");
  },
};

let opener: ExternalOpener = webOpener;

export function setExternalOpener(o: ExternalOpener): void {
  opener = o;
}

/** Opens an external link; anything but http(s) is ignored. */
export function openExternal(url: string): void {
  if (!isSafeExternalUrl(url)) return;
  opener.open(url);
}
