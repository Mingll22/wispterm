import type { LayoutState, LayoutTab, MobileInputMode, SurfaceView } from "./types";
import { terminalControl } from "./terminal_control";
import { tabControl } from "./tab_control";
import {
  readSavedDesktopPanelMode,
  readSavedMobilePanelMode,
  readSavedMobileVisualZoom,
  readSavedSidebarCollapsed,
} from "./storage";

export const state = {
  socket: null as WebSocket | null,
  layoutState: null as LayoutState | null,
  selectedTabIndex: 0,
  selectedSurfaceId: null as string | null,
  focusedSurfaceId: null as string | null,
  surfaceViews: new Map<string, SurfaceView>(),
  hasSeenLayout: false,
  kbdVisible: false,
  drawerOpen: false,
  sidebarCollapsed: readSavedSidebarCollapsed() ?? false,
  desktopPanelMode: readSavedDesktopPanelMode(),
  mobilePanelMode: readSavedMobilePanelMode(),
  mobileInputMode: "edit" as MobileInputMode,
  mobileVisualZoom: readSavedMobileVisualZoom(),
  activeSessionKey: null as string | null,
};

export function currentTab(): LayoutTab | null {
  const layout = state.layoutState;
  if (!layout) return null;
  return (
    layout.tabs.find((tab) => tab.index === state.selectedTabIndex) ??
    layout.tabs.find((tab) => tab.index === layout.activeTab) ??
    layout.tabs[0] ??
    null
  );
}

export function activeSurfaceIdForInput(): string | null {
  const tab = currentTab();
  const surfaceId = state.selectedSurfaceId ?? tab?.surfaces[0]?.id ?? null;
  if (!surfaceId) return null;
  const surface = tab?.surfaces.find((candidate) => candidate.id === surfaceId);
  if (surface?.kind === "ai_chat") return null;
  if ((surface?.terminalControl || tabControlId(tab)) && inputLeaseId(surfaceId, tab) === undefined) return null;
  return surface?.readOnly ? null : surfaceId;
}

export function tabControlId(tab = currentTab()): string | undefined {
  return state.layoutState?.tabControl ? tab?.workspace?.tabId : undefined;
}

export function inputLeaseId(surfaceId: string, tab = currentTab()): number | undefined {
  const tabId = tabControlId(tab);
  if (!tabId) return terminalControl.leaseId(surfaceId);
  return tab?.surfaces.some((surface) => surface.id === surfaceId) ? tabControl.leaseId(tabId) : undefined;
}

export function resetSurfaceViews(): void {
  state.surfaceViews = new Map();
  state.focusedSurfaceId = null;
}
