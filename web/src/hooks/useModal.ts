import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex >= 0 && el.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * Makes `ref`'s element a modal dialog (the element needs role="dialog" aria-modal="true"):
 * - initial focus on `[data-autofocus]` or the first focusable control (else the dialog itself);
 * - Tab / Shift+Tab cycle inside it;
 * - everything outside is `inert` while it is open;
 * - Escape calls `onClose`;
 * - focus returns to the previously focused element on unmount.
 * `onClose` may change on every render; the effect itself runs once per mount.
 */
export function useModal(ref: RefObject<HTMLElement>, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Background -> inert: every sibling along the path from the dialog up to <body>.
    const inerted: HTMLElement[] = [];
    for (let node: HTMLElement = dialog; node.parentElement; node = node.parentElement) {
      const parent: HTMLElement = node.parentElement;
      for (const sib of Array.from(parent.children)) {
        if (sib !== node && sib instanceof HTMLElement && !sib.hasAttribute("inert")) {
          sib.setAttribute("inert", "");
          inerted.push(sib);
        }
      }
      if (parent === document.body) break;
    }

    if (!dialog.hasAttribute("tabindex")) dialog.setAttribute("tabindex", "-1");
    const first = dialog.querySelector<HTMLElement>("[data-autofocus]") ?? focusableIn(dialog)[0] ?? dialog;
    first.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusableIn(dialog);
      if (items.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === firstEl || active === dialog || !dialog.contains(active))) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && (active === lastEl || !dialog.contains(active))) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);

    return () => {
      document.removeEventListener("keydown", onKey, true);
      for (const el of inerted) el.removeAttribute("inert");
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [ref]);
}
