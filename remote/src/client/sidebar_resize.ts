import { watchPointer } from "./pointer_drag";
import { readSavedSidebarWidth, saveSidebarWidth } from "./storage";

const DEFAULT_WIDTH = 252;
const MIN_WIDTH = 224;
const MAX_WIDTH = 460;
const KEYBOARD_STEP = 16;

export function bindSidebarResize(shell: HTMLElement, handle: HTMLElement): () => void {
  let preferredWidth = readSavedSidebarWidth() ?? DEFAULT_WIDTH;
  let cancelDrag: (() => void) | null = null;

  function syncWidth() {
    const maximum = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(shell.clientWidth * 0.45)));
    const width = Math.round(Math.max(MIN_WIDTH, Math.min(maximum, preferredWidth)));
    shell.style.setProperty("--sidebar-width", `${width}px`);
    handle.setAttribute("aria-valuemin", String(MIN_WIDTH));
    handle.setAttribute("aria-valuemax", String(maximum));
    handle.setAttribute("aria-valuenow", String(width));
    return { width, maximum };
  }

  function storeWidth(width: number): void {
    preferredWidth = width;
    saveSidebarWidth(syncWidth().width);
  }

  handle.addEventListener("pointerdown", (event) => {
    if (cancelDrag || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    const startX = event.clientX;
    const previousWidth = preferredWidth;
    const startWidth = syncWidth().width;
    cancelDrag = watchPointer(handle, event, (next) => {
      preferredWidth = startWidth + next.clientX - startX;
      syncWidth();
    }, (committed) => {
      cancelDrag = null;
      handle.removeAttribute("data-dragging");
      const { width } = syncWidth();
      if (committed && width !== startWidth) storeWidth(width);
      else {
        preferredWidth = previousWidth;
        syncWidth();
      }
    });
    handle.setAttribute("data-dragging", "");
  });

  handle.addEventListener("keydown", (event) => {
    if (cancelDrag) {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelDrag();
      }
      return;
    }
    const { width, maximum } = syncWidth();
    switch (event.key) {
      case "ArrowLeft": storeWidth(Math.max(MIN_WIDTH, width - KEYBOARD_STEP)); break;
      case "ArrowRight": storeWidth(Math.min(maximum, width + KEYBOARD_STEP)); break;
      case "Home": storeWidth(MIN_WIDTH); break;
      case "End": storeWidth(maximum); break;
      case "Enter": storeWidth(DEFAULT_WIDTH); break;
      default: return;
    }
    event.preventDefault();
  });
  handle.addEventListener("dblclick", () => storeWidth(DEFAULT_WIDTH));

  syncWidth();
  return syncWidth;
}
