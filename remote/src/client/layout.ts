import { tr } from "./i18n";
import type { LayoutState, LayoutSurface, LayoutTab, RelayMessage } from "./types";
import { numberOr, shortSurfaceId } from "./utils";
import { isWorkspaceId, parseWorkspaceTree } from "../workspace_protocol";
import { workspaceGeometry, workspaceTree } from "./workspace_layout";

export function isLayoutMessage(message: RelayMessage): boolean {
  return message.type === "layout" && Array.isArray(message.tabs);
}

export function normalizeLayout(message: RelayMessage): LayoutState {
  const activeTab = typeof message.activeTab === "number" ? message.activeTab : 0;
  const workspaceActions = message.workspaceActions === true;
  const rawTabs = Array.isArray(message.tabs) ? message.tabs : [];
  const tabs: LayoutTab[] = rawTabs
    .map((raw): LayoutTab | null => {
      if (!raw || typeof raw !== "object") return null;
      const tab = raw as Record<string, unknown>;
      const index = typeof tab.index === "number" ? tab.index : 0;
      let surfaces = Array.isArray(tab.surfaces)
        ? tab.surfaces.map(normalizeSurface).filter((surface): surface is LayoutSurface => Boolean(surface))
        : [];
      const workspace = workspaceActions ? normalizeTabWorkspace(tab, surfaces) : undefined;
      if (workspace) {
        const surfacesById = new Map(surfaces.map((surface) => [surface.id, surface]));
        surfaces = workspaceGeometry(workspace.tree).panes.map(({ surfaceId }) => surfacesById.get(surfaceId)!);
      }
      return {
        index,
        title: typeof tab.title === "string" ? tab.title : tr(`Tab ${index + 1}`, `标签页 ${index + 1}`),
        focusedSurfaceId: typeof tab.focusedSurfaceId === "string" ? tab.focusedSurfaceId : surfaces[0]?.id,
        surfaces,
        workspace,
      };
    })
    .filter((tab): tab is LayoutTab => Boolean(tab));
  return { activeTab, tabs, workspaceActions, tabControl: message.tabControl === true, tabRename: message.tabRename === true };
}

function normalizeTabWorkspace(tab: Record<string, unknown>, surfaces: LayoutSurface[]): LayoutTab["workspace"] {
  if (!isWorkspaceId(tab.tabId) || !isWorkspaceId(tab.layoutRevision)) return undefined;
  const nodes = parseWorkspaceTree(tab.splitTree);
  if (!nodes || surfaces.some((surface) => surface.kind === "ai_chat" || surface.readOnly)) return undefined;
  const leaves = new Set(nodes.flatMap((node) => "surfaceId" in node ? [node.surfaceId] : []));
  const surfaceIds = new Set(surfaces.map((surface) => surface.id));
  if (leaves.size * 2 - 1 !== nodes.length || leaves.size !== surfaces.length ||
      surfaceIds.size !== leaves.size || ![...leaves].every((id) => surfaceIds.has(id))) return undefined;
  return { tabId: tab.tabId, layoutRevision: tab.layoutRevision, tree: workspaceTree(nodes) };
}

export function resolveLayoutSelection(layout: LayoutState, previous: LayoutTab | null, surfaceId: string | null) {
  const tab = (previous?.workspace
    ? layout.tabs.find((entry) => entry.workspace?.tabId === previous.workspace?.tabId)
    : previous && (layout.tabs.find((entry) => entry.surfaces.some((surface) => surface.id === surfaceId)) ??
      layout.tabs.find((entry) => entry.index === previous.index))) ??
    layout.tabs.find((entry) => entry.index === layout.activeTab) ?? layout.tabs[0];
  return {
    tabIndex: tab?.index ?? layout.activeTab,
    surfaceId: tab?.surfaces.some((surface) => surface.id === surfaceId)
      ? surfaceId
      : tab?.focusedSurfaceId || tab?.surfaces[0]?.id || null,
  };
}

function normalizeSurface(raw: unknown): LayoutSurface | null {
  if (!raw || typeof raw !== "object") return null;
  const surface = raw as Record<string, unknown>;
  if (typeof surface.id !== "string") return null;
  return {
    id: surface.id,
    kind: surface.kind === "ai_chat" ? "ai_chat" : "terminal",
    readOnly: surface.readOnly === true,
    terminalControl: surface.terminalControl === true,
    title: typeof surface.title === "string" ? surface.title : shortSurfaceId(surface.id),
    focused: surface.focused === true,
    snapshot: typeof surface.snapshot === "string" ? surface.snapshot : "",
    cols: numberOr(surface.cols, 0),
    rows: numberOr(surface.rows, 0),
    cursorX: numberOr(surface.cursorX, 0),
    cursorY: numberOr(surface.cursorY, 0),
    requestInflight: typeof surface.requestInflight === "boolean" ? surface.requestInflight : undefined,
    requestStopping: typeof surface.requestStopping === "boolean" ? surface.requestStopping : undefined,
    x: numberOr(surface.x, 0),
    y: numberOr(surface.y, 0),
    w: numberOr(surface.w, 1),
    h: numberOr(surface.h, 1),
  };
}
