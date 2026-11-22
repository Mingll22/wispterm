import { tr } from "./i18n";
import { watchPointer } from "./pointer_drag";
import type { LayoutTab } from "./types";
import {
  paneDropEdge,
  rearrangePanes,
  resetSplitRatios,
  resizeSplitTrack,
  sharedSplitTracks,
  workspaceGeometry,
  type DropEdge,
  type PaneRect,
  type SplitTrack,
  type WorkspaceGeometry,
  type WorkspaceTree,
} from "./workspace_layout";

type Workspace = NonNullable<LayoutTab["workspace"]>;
type PanelActions = {
  close: (workspace: Workspace, surfaceId: string) => void;
  apply: (workspace: Workspace, tree: WorkspaceTree) => void;
  select: (surfaceId: string) => void;
  previewEnded: () => void;
};
type MirroredLayout = { workspace: Workspace; geometry: WorkspaceGeometry; tracks: SplitTrack[] };

export function positionWorkspacePane(panel: HTMLElement, rect: PaneRect): void {
  panel.style.left = percent(rect.x);
  panel.style.top = percent(rect.y);
  panel.style.width = percent(rect.width);
  panel.style.height = percent(rect.height);
}

export function bindWorkspacePanels(stage: HTMLElement, actions: PanelActions) {
  let workspace: Workspace | undefined;
  let mirrored: MirroredLayout | null = null;
  let available = false;
  let cancelPointer: (() => void) | null = null;
  let preview: WorkspaceGeometry | null = null;
  const splitters = new Map<string, HTMLElement>();

  function update(tab: LayoutTab | null, mirror: boolean, canEdit: boolean): void {
    workspace = tab?.workspace;
    available = canEdit;
    const next = mirror && workspace && (tab?.surfaces.length ?? 0) > 1 ? workspace : undefined;
    if (next?.tabId !== mirrored?.workspace.tabId || next?.layoutRevision !== mirrored?.workspace.layoutRevision) {
      const geometry = next ? workspaceGeometry(next.tree) : undefined;
      mirrored = next && geometry ? { workspace: next, geometry, tracks: sharedSplitTracks(geometry.dividers) } : null;
      cancelPointer?.();
      syncSplitters();
    } else if (!canEdit) {
      cancelPointer?.();
    } else if (preview) {
      drawPreview(preview);
    }
    stage.toggleAttribute("data-workspace-splits", mirrored !== null);
    stage.querySelectorAll<HTMLButtonElement>(".pane-drag-handle, .pane-close").forEach((button) => {
      button.disabled = !canEdit;
    });
    for (const handle of splitters.values()) {
      handle.tabIndex = canEdit ? 0 : -1;
      handle.setAttribute("aria-disabled", String(!canEdit));
    }
  }

  function syncSplitters(): void {
    const keys = new Set<string>();
    for (const track of mirrored?.tracks ?? []) {
      const key = track.paths[0];
      keys.add(key);
      let handle = splitters.get(key);
      if (!handle) {
        handle = document.createElement("div");
        handle.className = "workspace-splitter";
        handle.dataset.splitPath = key;
        handle.setAttribute("role", "separator");
        handle.setAttribute("aria-valuemin", "0");
        handle.setAttribute("aria-valuemax", "100");
        handle.title = tr("Double-click to reset split proportions", "双击恢复默认分屏比例");
        handle.setAttribute("aria-description", tr("Use arrow keys to resize and Enter to reset.", "用方向键调整，按 Enter 恢复默认比例。"));
        stage.appendChild(handle);
        splitters.set(key, handle);
      }
      const vertical = track.axis === "x";
      handle.dataset.axis = track.axis;
      handle.dataset.segments = String(track.paths.length);
      handle.setAttribute("aria-label", vertical ? tr("Resize split width", "调整左右分屏宽度") : tr("Resize split height", "调整上下分屏高度"));
      handle.setAttribute("aria-orientation", vertical ? "vertical" : "horizontal");
      positionTrack(handle, track);
    }
    for (const [key, element] of splitters) {
      if (!keys.has(key)) {
        element.remove();
        splitters.delete(key);
      }
    }
  }

  function drawPreview(geometry: WorkspaceGeometry): void {
    for (const pane of geometry.panes) {
      const element = stage.querySelector<HTMLElement>(`.remote-panel[data-surface-id="${pane.surfaceId}"]`);
      if (element) positionWorkspacePane(element, pane);
    }
    const byPath = new Map(geometry.dividers.map((divider) => [divider.path, divider]));
    for (const track of mirrored?.tracks ?? []) {
      const first = byPath.get(track.paths[0]);
      const last = byPath.get(track.paths.at(-1)!);
      const handle = splitters.get(track.paths[0]);
      if (first && last && handle) positionTrack(handle, { ...first, end: last.end });
    }
  }

  function startPaneDrag(event: PointerEvent, handle: HTMLButtonElement, layout: MirroredLayout, source: string): void {
    handle.toggleAttribute("data-grabbing", true);
    let drop: { mount: HTMLElement; target: string; edge: DropEdge } | null = null;
    const clearDrop = (): void => {
      drop?.mount.removeAttribute("data-drop");
      drop = null;
    };
    cancelPointer = watchPointer(handle, event, (next) => {
      if (!drop && Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) < 7) return;
      clearDrop();
      const panel = document.elementFromPoint(next.clientX, next.clientY)?.closest<HTMLElement>(".remote-panel");
      const target = panel?.dataset.surfaceId;
      const mount = panel?.querySelector<HTMLElement>(".terminal-mount");
      if (!panel || panel.parentElement !== stage || !target || target === source || !mount) return;
      const edge = paneDropEdge(mount.getBoundingClientRect(), next.clientX, next.clientY);
      mount.dataset.drop = edge;
      drop = { mount, target, edge };
    }, (committed) => {
      cancelPointer = null;
      handle.removeAttribute("data-grabbing");
      const target = drop;
      clearDrop();
      if (committed && target) {
        actions.apply(layout.workspace, rearrangePanes(layout.workspace.tree, source, target.target, target.edge));
      }
    });
  }

  function startSplitResize(event: PointerEvent, handle: HTMLElement, layout: MirroredLayout, track: SplitTrack): void {
    const inX = track.axis === "x";
    const size = inX ? stage.clientWidth : stage.clientHeight;
    const start = inX ? event.clientX : event.clientY;
    const original = layout.workspace.tree;
    let tree = original;
    cancelPointer = watchPointer(handle, event, (next) => {
      const distance = (inX ? next.clientX : next.clientY) - start;
      if (Math.abs(distance) < 2 && !preview) return;
      tree = resizeSplitTrack(original, layout.geometry, layout.tracks, track, track.at + distance / size, size);
      preview = workspaceGeometry(tree);
      stage.toggleAttribute("data-split-preview", true);
      drawPreview(preview);
    }, (committed) => {
      cancelPointer = null;
      if (preview) {
        preview = null;
        stage.removeAttribute("data-split-preview");
        if (mirrored === layout) drawPreview(layout.geometry);
        actions.previewEnded();
      }
      if (committed && tree !== original) actions.apply(layout.workspace, tree);
    });
  }

  // The terminal header consumes pointer/click events before they reach a pane.
  // Capture only the workspace's own controls so ordinary terminal input stays local.
  stage.addEventListener("pointerdown", (event) => {
    if (!available || !mirrored || cancelPointer || event.button !== 0 || !event.isPrimary || !(event.target instanceof Element)) return;
    const drag = event.target.closest<HTMLButtonElement>(".pane-drag-handle");
    const source = paneId(drag);
    if (drag && source) {
      startPaneDrag(event, drag, mirrored, source);
      return;
    }
    const splitter = event.target.closest<HTMLElement>(".workspace-splitter");
    const track = mirrored.tracks.find((entry) => entry.paths[0] === splitter?.dataset.splitPath);
    if (splitter && track) startSplitResize(event, splitter, mirrored, track);
  }, true);

  stage.addEventListener("click", (event) => {
    if (!available || !workspace || !(event.target instanceof Element)) return;
    const surfaceId = paneId(event.target);
    if (!surfaceId) return;
    if (event.target.closest(".pane-close")) actions.close(workspace, surfaceId);
    else if (event.target.closest(".pane-drag-handle")) actions.select(surfaceId);
  }, true);

  function reset(layout: MirroredLayout): void {
    const tree = resetSplitRatios(layout.workspace.tree);
    if (tree !== layout.workspace.tree) actions.apply(layout.workspace, tree);
  }

  stage.addEventListener("dblclick", (event) => {
    if (available && mirrored && event.target instanceof Element && event.target.closest(".workspace-splitter")) reset(mirrored);
  });

  stage.addEventListener("keydown", (event) => {
    if (!available || !mirrored || !(event.target instanceof HTMLElement)) return;
    const track = mirrored.tracks.find((entry) => entry.paths[0] === (event.target as HTMLElement).dataset.splitPath);
    if (!track) return;
    const inX = track.axis === "x";
    const decrease = inX ? "ArrowLeft" : "ArrowUp";
    const increase = inX ? "ArrowRight" : "ArrowDown";
    if (event.key === "Enter") {
      event.preventDefault();
      reset(mirrored);
    } else if (event.key === decrease || event.key === increase) {
      event.preventDefault();
      const size = inX ? stage.clientWidth : stage.clientHeight;
      const requested = track.at + (event.key === decrease ? -0.035 : 0.035);
      const tree = resizeSplitTrack(mirrored.workspace.tree, mirrored.geometry, mirrored.tracks, track, requested, size);
      if (tree !== mirrored.workspace.tree) actions.apply(mirrored.workspace, tree);
    }
  });

  return { update };
}

function paneId(target: Element | null): string | undefined {
  return target?.closest<HTMLElement>(".remote-panel")?.dataset.surfaceId;
}

function percent(value: number): string {
  return `${value * 100}%`;
}

function positionTrack(handle: HTMLElement, track: Omit<SplitTrack, "paths">): void {
  const inX = track.axis === "x";
  handle.style.left = percent(inX ? track.at : track.start);
  handle.style.top = percent(inX ? track.start : track.at);
  handle.style.width = inX ? "" : percent(track.end - track.start);
  handle.style.height = inX ? percent(track.end - track.start) : "";
  handle.setAttribute("aria-valuenow", String(Math.round(track.at * 100)));
}
