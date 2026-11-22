import { normalizeMobileVisualZoom } from "./mobile_visual_zoom";
import type { PanelMode, MobileVisualZoom, ThemeMode } from "./types";

const SESSION_KEY_STORAGE_KEY = "wispterm.remote.sessionKey";
const THEME_STORAGE_KEY = "wispterm.remote.theme";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "wispterm.remote.sidebarCollapsed";
const DESKTOP_PANEL_MODE_STORAGE_KEY = "wispterm.remote.desktopPanelMode";
const MOBILE_PANEL_MODE_STORAGE_KEY = "wispterm.remote.mobilePanelMode";
const MOBILE_VISUAL_ZOOM_STORAGE_KEY = "wispterm.remote.mobileVisualZoom";

export function readSavedSessionKey(): string {
  try {
    return localStorage.getItem(SESSION_KEY_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function saveSessionKey(sessionKey: string): void {
  if (!sessionKey) {
    clearSessionKey();
    return;
  }
  try {
    localStorage.setItem(SESSION_KEY_STORAGE_KEY, sessionKey);
  } catch {
    // Storage may be unavailable in restricted browser contexts.
  }
}

export function clearSessionKey(): void {
  try {
    localStorage.removeItem(SESSION_KEY_STORAGE_KEY);
  } catch {
    // Storage may be unavailable in restricted browser contexts.
  }
}

export function maskSessionKey(sessionKey: string): string {
  if (!sessionKey) return "";
  return `${sessionKey.slice(0, 4)}****`;
}

export function readSavedSidebarCollapsed(): boolean | null {
  try {
    const raw = localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  } catch {
    return null;
  }
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    // Storage may be unavailable in restricted browser contexts.
  }
}

export function readSavedDesktopPanelMode(): PanelMode {
  return readSavedPanelMode(DESKTOP_PANEL_MODE_STORAGE_KEY, "layout");
}

export function readSavedMobilePanelMode(): PanelMode {
  return readSavedPanelMode(MOBILE_PANEL_MODE_STORAGE_KEY, "single");
}

function readSavedPanelMode(key: string, defaultMode: PanelMode): PanelMode {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "layout" || raw === "single") return raw;
  } catch {
    // Storage may be unavailable in restricted browser contexts.
  }
  return defaultMode;
}

export function savePanelMode(mode: PanelMode, mobile: boolean): void {
  try {
    localStorage.setItem(mobile ? MOBILE_PANEL_MODE_STORAGE_KEY : DESKTOP_PANEL_MODE_STORAGE_KEY, mode);
  } catch {
    // Storage may be unavailable in restricted browser contexts.
  }
}

export function readSavedMobileVisualZoom(): MobileVisualZoom {
  try {
    return normalizeMobileVisualZoom(localStorage.getItem(MOBILE_VISUAL_ZOOM_STORAGE_KEY));
  } catch {
    return 1;
  }
}

export function saveMobileVisualZoom(zoom: MobileVisualZoom): void {
  try {
    localStorage.setItem(MOBILE_VISUAL_ZOOM_STORAGE_KEY, String(zoom));
  } catch {
    // Storage may be unavailable in restricted browser contexts.
  }
}

export function readSavedTheme(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === "light" || raw === "dark") return raw;
  } catch {
    // localStorage may be unavailable.
  }
  return "dark";
}

export function saveTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Storage may be unavailable.
  }
}
