import { tr } from "./i18n";
import { iconClose } from "./icons";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import type { LayoutSurface, SurfaceView } from "./types";
import {
  CANVAS_WHEEL_EVENT_OPTIONS,
  canvasPanRenderState,
  defaultCanvasPan,
  fitTerminalCanvas,
  isCanvasDrag,
  meaningfulTerminalCanvasHeight,
  panYFromVerticalScrollbarThumb,
  panCanvasBy,
  panCanvasByWheel,
  resizeCanvasPan,
  shouldConsumeCanvasWheel,
  shouldDeferCanvasPanPointerDownDefault,
  shouldStartCanvasPanDrag,
  terminalCanScrollHistory,
  touchHistoryScrollLines,
  verticalScrollbarMetrics,
  type CanvasPoint,
  type CanvasSize,
} from "./mobile_canvas";
import { shouldFocusTerminalElement } from "./focus_policy";
import { parseAiChatTranscript, type AiChatMessage } from "./ai_chat_transcript";
import { aiChatStopControlState } from "./ai_chat_controls";
import { isMobileRemoteShell, shouldUseCanvasPan, shouldUseViewportFit } from "./mobile_layout";
import { mobileVisualZoomPercent, scaleVisualCanvasSize } from "./mobile_visual_zoom";
import { setNativeTerminalInputBlocked, shouldBlockNativeTerminalInput } from "./terminal_input_guard";
import { cursorMoveSequence, emptyState, validPositiveInteger } from "./utils";
import { currentTab, resetSurfaceViews, state } from "./state";
import { getTerminalPalette, subscribeToTheme } from "./theme";
import { REMOTE_TERMINAL_SCROLLBACK } from "./terminal_options";
import { mapScaledTerminalPointer } from "./terminal_pointer";
import { supportedTerminalGrid, terminalControl, type TerminalControlTarget } from "./terminal_control";
import { workspaceGeometry } from "./workspace_layout";
import { positionWorkspacePane } from "./workspace_panels";
import {
  shouldBufferLiveOutputForInitialSnapshot,
  shouldFlushBufferedOutput,
  shouldScheduleInitialSnapshotReplay,
} from "./snapshot_replay";

Terminal.strings.promptLabel = tr("Terminal input", "终端输入");
Terminal.strings.tooMuchOutput = tr("Too much output. Navigate to rows manually to read", "终端输出过多，可逐行浏览内容");

const PENDING_OUTPUT_LIMIT = 128 * 1024;
const MOBILE_CANVAS_BOTTOM_GUTTER = 12;
const MOBILE_SCROLLBAR_MIN_THUMB_HEIGHT = 24;
const MOBILE_SCROLLBAR_VERTICAL_INSET = 8;
const DESKTOP_SCROLLBAR_MIN_THUMB_HEIGHT = 32;
const DESKTOP_SCROLLBAR_VERTICAL_INSET = 10;

type InputHandler = (surfaceId: string, data: string) => void;
let controlMeasurementQueued = false;
let inputHandler: InputHandler = () => {
  // no-op until transport registers
};

export function setSurfaceInputHandler(handler: InputHandler): void {
  inputHandler = handler;
}

subscribeToTheme((palette) => {
  for (const view of state.surfaceViews.values()) {
    view.term.options.theme = palette;
    if (view.opened && view.term.rows > 0) {
      view.term.refresh(0, view.term.rows - 1);
    }
  }
});

export function ensureSurfaceView(surfaceId: string): SurfaceView {
  const existing = state.surfaceViews.get(surfaceId);
  if (existing) return existing;

  const host = document.createElement("div");
  host.className = "terminal-host";
  const panel = document.createElement("section");
  panel.className = "remote-panel";
  panel.dataset.surfaceId = surfaceId;
  const mount = document.createElement("div");
  mount.className = "terminal-mount";
  const scrollbar = document.createElement("div");
  scrollbar.className = "canvas-scrollbar";
  scrollbar.dataset.visible = "false";
  scrollbar.setAttribute("aria-hidden", "true");
  const scrollbarThumb = document.createElement("div");
  scrollbarThumb.className = "canvas-scrollbar-thumb";
  scrollbar.appendChild(scrollbarThumb);
  const control = document.createElement("header");
  control.className = "terminal-lease";
  control.tabIndex = -1;
  control.hidden = true;
  const controlTitle = document.createElement("span");
  controlTitle.className = "terminal-lease-title";
  const controlButton = document.createElement("button");
  controlButton.type = "button";
  const paneDragHandle = document.createElement("button");
  paneDragHandle.type = "button";
  paneDragHandle.className = "pane-drag-handle";
  paneDragHandle.hidden = true;
  const paneCloseButton = document.createElement("button");
  paneCloseButton.type = "button";
  paneCloseButton.className = "secondary-button pane-close";
  paneCloseButton.hidden = true;
  paneCloseButton.innerHTML = iconClose();
  const paneActions = document.createElement("div");
  paneActions.className = "terminal-pane-actions";
  paneActions.appendChild(controlButton);
  paneActions.appendChild(paneCloseButton);
  control.appendChild(controlTitle);
  control.appendChild(paneDragHandle);
  control.appendChild(paneActions);
  control.addEventListener("pointerdown", (event) => event.stopPropagation());
  control.addEventListener("click", (event) => event.stopPropagation());
  controlButton.addEventListener("click", () => {
    if (terminalControl.leaseId(surfaceId) === undefined) terminalControl.takeOver(surfaceId);
    else terminalControl.release(surfaceId);
    applySurfaceInputPolicy(view, currentTab()?.surfaces.find((surface) => surface.id === surfaceId));
  });
  mount.appendChild(control);
  mount.appendChild(host);
  mount.appendChild(scrollbar);
  panel.appendChild(mount);

  const selectThis = (): void => {
    state.selectedSurfaceId = surfaceId;
    renderRemotePanels();
  };
  panel.addEventListener("pointerdown", selectThis);
  panel.addEventListener("click", () => {
    selectThis();
    focusSurfaceView(surfaceId);
  });

  const fit = new FitAddon();
  const term = new Terminal({
    cursorBlink: true,
    cursorInactiveStyle: "outline",
    cursorStyle: "bar",
    cursorWidth: 2,
    convertEol: true,
    disableStdin: false,
    fontFamily: '"JetBrains Mono", "Cascadia Mono", monospace',
    fontSize: 13,
    scrollback: REMOTE_TERMINAL_SCROLLBACK,
    theme: getTerminalPalette(),
  });
  term.loadAddon(fit);

  const view: SurfaceView = {
    panel,
    mount,
    host,
    control,
    controlTitle,
    controlButton,
    paneDragHandle,
    paneCloseButton,
    scrollbar,
    scrollbarThumb,
    aiContainer: null,
    aiTranscript: null,
    aiInput: null,
    aiSend: null,
    aiStop: null,
    term,
    fit,
    decoder: new TextDecoder(),
    disposeInput: term.onData((data) => {
      if (isViewModeInputBlocked()) return;
      const current = state.layoutState?.tabs
        .flatMap((tab) => tab.surfaces)
        .find((surface) => surface.id === surfaceId);
      if (current?.kind === "ai_chat") return;
      if (current?.readOnly) return;
      inputHandler(surfaceId, data);
    }),
    disposeMiddleClickGesture: null,
    disposeCanvasPan: null,
    resizeObserver: null,
    fitQueued: false,
    queuedGridChanges: 0,
    measuredGrid: null,
    canvasPan: { x: 0, y: 0 },
    lastCanvasViewport: null,
    needsDefaultCanvasPan: false,
    hasLiveOutput: false,
    snapshotApplied: false,
    initialSnapshotPending: false,
    snapshotText: null,
    opened: false,
    pendingTerminalWrites: [],
    bufferedOutputLength: 0,
    remoteCols: null,
    remoteRows: null,
  };
  view.disposeMiddleClickGesture = bindTwoFingerMiddleClick(view);
  view.disposeCanvasPan = bindCanvasPan(view);
  state.surfaceViews.set(surfaceId, view);
  return view;
}

export function renderRemotePanels(): void {
  const panelsRoot = document.querySelector<HTMLDivElement>("#remote-panels");
  const titleRoot = document.querySelector<HTMLSpanElement>("#workspace-title");
  if (!panelsRoot) return;

  const tab = currentTab();
  const paneMode = isMobileRemoteShell() ? state.mobilePanelMode : state.desktopPanelMode;
  const selectedSurface = tab?.surfaces.find((surface) => surface.id === state.selectedSurfaceId) ?? tab?.surfaces[0];
  const workspace = panelsRoot.closest(".workspace");
  const titleInPane = Boolean(selectedSurface && (tab?.workspace || (selectedSurface.terminalControl && !selectedSurface.readOnly)));
  workspace?.toggleAttribute("data-context-title", Boolean(selectedSurface && !titleInPane));
  workspace?.toggleAttribute("data-title-in-pane", titleInPane);
  workspace?.toggleAttribute("data-panel-selector", (tab?.surfaces.length ?? 0) > 1 && state.desktopPanelMode === "single");
  if (!tab || tab.surfaces.length === 0) {
    panelsRoot.className = "panels-stage empty";
    delete panelsRoot.dataset.mobileMode;
    delete panelsRoot.dataset.desktopMode;
    panelsRoot.replaceChildren(emptyState(tr("No panels for this tab yet.", "此标签页暂无面板")));
    const fallback = tab?.title || tr("Remote terminal", "远程终端");
    if (titleRoot) {
      titleRoot.textContent = fallback;
      titleRoot.title = fallback;
    }
    const mobileTitleRoot = document.querySelector<HTMLSpanElement>("#mobile-workspace-title");
    if (mobileTitleRoot) {
      mobileTitleRoot.textContent = fallback;
      mobileTitleRoot.title = fallback;
    }
    scheduleControlMeasurement();
    return;
  }

  const tabTitle = tab.title || tr(`Tab ${tab.index + 1}`, `标签页 ${tab.index + 1}`);
  if (titleRoot) {
    titleRoot.textContent = tabTitle;
    titleRoot.title = tabTitle;
  }
  const mobileTitleRoot = document.querySelector<HTMLSpanElement>("#mobile-workspace-title");
  if (mobileTitleRoot) {
    mobileTitleRoot.textContent = tabTitle;
    mobileTitleRoot.title = tabTitle;
  }
  panelsRoot.className = "panels-stage";
  panelsRoot.dataset.mobileMode = state.mobilePanelMode;
  panelsRoot.dataset.desktopMode = state.desktopPanelMode;
  panelsRoot.querySelectorAll(".empty-state").forEach((node) => node.remove());
  const visible = new Set(tab.surfaces.map((surface) => surface.id));
  const panePositions = tab.workspace
    ? new Map(workspaceGeometry(tab.workspace.tree).panes.map((pane) => [pane.surfaceId, pane]))
    : null;

  for (const surface of tab.surfaces) {
    const view = ensureSurfaceView(surface.id);
    const selected = surface.id === state.selectedSurfaceId;
    view.panel.className = `remote-panel${selected ? " selected" : ""}${surface.kind === "ai_chat" ? " ai-chat-panel" : ""}`;
    view.panel.setAttribute("aria-label", surface.title?.trim() || tr("Terminal panel", "终端面板"));
    positionWorkspacePane(view.panel, panePositions?.get(surface.id) ?? {
      x: surface.x ?? 0, y: surface.y ?? 0, width: Math.max(0.05, surface.w ?? 1), height: Math.max(0.05, surface.h ?? 1),
    });
    view.paneCloseButton.hidden = !tab.workspace;
    view.paneDragHandle.hidden = !tab.workspace || tab.surfaces.length < 2 || paneMode === "single";
    applySurfaceInputPolicy(view, surface);
    const nextRemoteCols = validPositiveInteger(surface.cols);
    const nextRemoteRows = validPositiveInteger(surface.rows);
    const gridChanged = view.remoteCols !== nextRemoteCols || view.remoteRows !== nextRemoteRows;
    view.remoteCols = nextRemoteCols;
    view.remoteRows = nextRemoteRows;
    if (gridChanged) view.needsDefaultCanvasPan = true;

    if (view.panel.parentElement !== panelsRoot) {
      panelsRoot.appendChild(view.panel);
    }

    if (surface.kind === "ai_chat") {
      renderAiChatPanel(view, surface);
      continue;
    }

    ensureTerminalMount(view);
    applySurfaceVisualZoom(view);
    if (!view.opened) {
      view.term.open(view.host);
      mapScaledTerminalPointer(view.term, () => !view.control.hidden);
      view.opened = true;
      applySurfaceVisualZoom(view);
      syncTerminalNativeInputGuard(view);
      view.resizeObserver = new ResizeObserver(() => {
        scheduleFit(view);
        scheduleControlMeasurement();
      });
      view.resizeObserver.observe(view.host);
      const screen = view.host.querySelector(".xterm-screen");
      if (screen) view.resizeObserver.observe(screen);
    }
    updateSurfaceCursor(view, surface.id);
    applyInitialSnapshot(view, surface);
    flushPendingOutput(view);
    scheduleFit(view);

    if (
      surface.id === state.selectedSurfaceId &&
      shouldFocusTerminalElement() &&
      document.activeElement &&
      view.panel.contains(document.activeElement)
    ) {
      view.term.focus();
    }
  }

  for (const [surfaceId, view] of state.surfaceViews) {
    if (!visible.has(surfaceId) && view.panel.parentElement === panelsRoot) {
      view.panel.remove();
    }
  }
  scheduleControlMeasurement();
}

export function focusAndFitSelectedSurface(): void {
  const id = state.selectedSurfaceId;
  if (!id) return;
  const view = state.surfaceViews.get(id);
  if (!view) return;
  if (view.aiInput) {
    if (!isMobileRemoteShell()) view.aiInput.focus();
    return;
  }
  if (shouldFocusTerminalElement()) view.term.focus();
  scheduleFit(view);
}

export function reconcileSurfaceViews(): void {
  if (!state.layoutState) return;
  const live = new Set(state.layoutState.tabs.flatMap((tab) => tab.surfaces.map((surface) => surface.id)));
  for (const [surfaceId, view] of state.surfaceViews) {
    if (!live.has(surfaceId)) {
      view.resizeObserver?.disconnect();
      view.disposeInput.dispose();
      view.disposeMiddleClickGesture?.();
      view.disposeCanvasPan?.();
      view.term.dispose();
      // Detach the panel too: left on the stage it stayed clickable and a
      // click re-created a terminal for the dead surface id.
      view.panel.remove();
      state.surfaceViews.delete(surfaceId);
    }
  }
}

export function disposeSurfaceViews(): void {
  for (const view of state.surfaceViews.values()) {
    view.resizeObserver?.disconnect();
    view.disposeInput.dispose();
    view.disposeMiddleClickGesture?.();
    view.disposeCanvasPan?.();
    view.term.dispose();
    view.panel.remove();
  }
  resetSurfaceViews();
}

export function writeSurfaceBytes(surfaceId: string, bytes: Uint8Array): void {
  const view = ensureSurfaceView(surfaceId);
  view.hasLiveOutput = true;
  writeSurfaceText(view, view.decoder.decode(bytes, { stream: true }));
}

export function writeLegacyOutput(data: string): void {
  const surfaceId = state.selectedSurfaceId ?? currentTab()?.surfaces[0]?.id ?? "legacy";
  const view = ensureSurfaceView(surfaceId);
  view.hasLiveOutput = true;
  writeSurfaceText(view, data);
}

export function refitAllSurfaces(): void {
  for (const view of state.surfaceViews.values()) scheduleFit(view);
  scheduleControlMeasurement();
}

export function applyTerminalGrid(surfaceId: string, cols: number, rows: number): void {
  const surface = state.layoutState?.tabs.flatMap((tab) => tab.surfaces).find((entry) => entry.id === surfaceId);
  if (!surface) return;
  const view = ensureSurfaceView(surfaceId);
  if (shouldBufferLiveOutputForInitialSnapshot(view)) {
    const writes = view.pendingTerminalWrites;
    const previous = writes.at(-1);
    if (previous && typeof previous !== "string") writes[writes.length - 1] = { cols, rows };
    else writes.push({ cols, rows });
    return;
  }
  surface.cols = cols;
  surface.rows = rows;
  queueTerminalGrid(view, cols, rows);
}

function queueTerminalGrid(view: SurfaceView, cols: number, rows: number): void {
  if (view.remoteCols === cols && view.remoteRows === rows) return;
  view.remoteCols = cols;
  view.remoteRows = rows;

  // Preserve the order of already queued xterm writes and the host's grid change.
  view.queuedGridChanges++;
  view.term.write("", () => {
    view.queuedGridChanges--;
    if (view.term.cols !== cols || view.term.rows !== rows) view.term.resize(cols, rows);
    placeTerminalGrid(view);
    view.needsDefaultCanvasPan = true;
    scheduleFit(view);
  });
}

function scheduleControlMeasurement(): void {
  if (controlMeasurementQueued) return;
  controlMeasurementQueued = true;
  requestAnimationFrame(() => {
    controlMeasurementQueued = false;
    if (document.getElementById("remote-panels")?.hasAttribute("data-split-preview")) return;
    const targets: TerminalControlTarget[] = [];
    for (const surface of currentTab()?.surfaces ?? []) {
      if (!surface.terminalControl || surface.readOnly) continue;
      const view = state.surfaceViews.get(surface.id);
      if (!view?.opened || !view.host.isConnected || !view.host.clientWidth || !view.host.clientHeight) continue;
      targets.push({ surfaceId: surface.id, grid: measureControlGrid(view) });
    }
    terminalControl.reconcile(targets, document.visibilityState === "visible");
  });
}

function measureControlGrid(view: SurfaceView): TerminalControlTarget["grid"] {
  const { clientWidth: width, clientHeight: height } = view.host;
  const dpr = window.devicePixelRatio;
  const previous = view.measuredGrid;
  // Xterm's measured cell size can change slightly when its grid is rounded.
  // Actual viewport changes alone should generate another size proposal.
  if (previous?.width === width && previous.height === height && previous.dpr === dpr) {
    return { cols: previous.cols, rows: previous.rows };
  }

  const dimensions = view.fit.proposeDimensions();
  if (!dimensions) return undefined;
  const grid = supportedTerminalGrid(dimensions);
  view.measuredGrid = { width, height, dpr, ...grid };
  return grid;
}

export function updateSurfaceCursors(): void {
  for (const [surfaceId, view] of state.surfaceViews) {
    const surface = state.layoutState?.tabs
      .flatMap((tab) => tab.surfaces)
      .find((candidate) => candidate.id === surfaceId);
    applySurfaceInputPolicy(view, surface);
    updateSurfaceCursor(view, surfaceId);
  }
}

export function syncTerminalNativeInputGuards(): void {
  for (const view of state.surfaceViews.values()) {
    syncTerminalNativeInputGuard(view);
  }
}

export function syncSurfaceVisualZooms(): void {
  for (const view of state.surfaceViews.values()) {
    applySurfaceVisualZoom(view);
    view.needsDefaultCanvasPan = true;
    view.lastCanvasViewport = null;
    scheduleFit(view);
  }
}

function focusSurfaceView(surfaceId: string): void {
  const view = ensureSurfaceView(surfaceId);
  if (view.aiInput) {
    if (!isMobileRemoteShell()) view.aiInput.focus();
    return;
  }
  if (shouldFocusTerminalElement()) view.term.focus();
}

function ensureTerminalMount(view: SurfaceView): void {
  if (view.host.parentElement === view.mount && view.scrollbar.parentElement === view.mount) return;
  view.mount.className = "terminal-mount";
  view.mount.replaceChildren(view.control, view.host, view.scrollbar);
}

function applySurfaceVisualZoom(view: SurfaceView): void {
  const zoom = isMobileRemoteShell() ? state.mobileVisualZoom : 1;
  view.panel.dataset.visualZoom = String(mobileVisualZoomPercent(zoom));
  view.host.style.setProperty("--remote-terminal-visual-zoom", String(zoom));
}

function renderAiChatPanel(view: SurfaceView, surface: LayoutSurface): void {
  const container = ensureAiChatElements(view, surface.id);
  if (container.parentElement !== view.mount) {
    view.mount.className = "terminal-mount ai-chat-mount";
    view.mount.replaceChildren(container);
  }
  const snapshot = surface.snapshot || tr("No messages yet.", "暂无消息");
  if (view.snapshotText !== snapshot && view.aiTranscript) {
    view.snapshotText = snapshot;
    renderAiChatTranscript(view.aiTranscript, snapshot);
    requestAnimationFrame(() => {
      if (view.aiTranscript) view.aiTranscript.scrollTop = view.aiTranscript.scrollHeight;
    });
  }
  updateAiChatControl(view, surface);
}

function ensureAiChatElements(view: SurfaceView, surfaceId: string): HTMLDivElement {
  if (view.aiContainer && view.aiTranscript && view.aiInput && view.aiSend && view.aiStop) return view.aiContainer;

  const container = document.createElement("div");
  container.className = "ai-chat-remote";

  const transcript = document.createElement("div");
  transcript.className = "ai-chat-transcript";

  const form = document.createElement("form");
  form.className = "ai-chat-composer";

  const input = document.createElement("textarea");
  input.className = "ai-chat-input";
  input.rows = 3;
  input.placeholder = tr("Ask Agent", "向智能助手提问");
  input.spellcheck = false;

  const send = document.createElement("button");
  send.className = "ai-chat-send";
  send.type = "submit";
  send.textContent = tr("Send", "发送");

  const stop = document.createElement("button");
  stop.className = "ai-chat-stop";
  stop.type = "button";
  stop.textContent = tr("Stop", "停止");
  stop.disabled = true;

  const submit = (): void => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    inputHandler(surfaceId, `${text}\r`);
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      inputHandler(surfaceId, "\x1b");
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
  });

  stop.addEventListener("click", () => {
    stop.disabled = true;
    stop.textContent = tr("Stopping", "正在停止…");
    stop.dataset.active = "false";
    inputHandler(surfaceId, "\x1b");
  });

  form.appendChild(input);
  form.appendChild(send);
  form.appendChild(stop);
  container.appendChild(transcript);
  container.appendChild(form);

  view.aiContainer = container;
  view.aiTranscript = transcript;
  view.aiInput = input;
  view.aiSend = send;
  view.aiStop = stop;
  return container;
}

function updateAiChatControl(view: SurfaceView, surface: LayoutSurface): void {
  if (!view.aiStop) return;
  const connected = state.socket?.readyState === WebSocket.OPEN;
  const stopState = aiChatStopControlState(surface, connected);
  view.aiStop.disabled = stopState.disabled;
  view.aiStop.textContent = stopState.label;
  view.aiStop.dataset.active = String(surface.requestInflight === true && !stopState.disabled);
}

export function updateAiChatControls(): void {
  const surfaces = state.layoutState?.tabs.flatMap((tab) => tab.surfaces) ?? [];
  for (const surface of surfaces) {
    if (surface.kind !== "ai_chat") continue;
    const view = state.surfaceViews.get(surface.id);
    if (view) updateAiChatControl(view, surface);
  }
}

function renderAiChatTranscript(root: HTMLDivElement, snapshot: string): void {
  const messages = parseAiChatTranscript(snapshot);
  root.replaceChildren();

  if (messages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ai-chat-empty";
    empty.textContent = tr("No messages yet.", "暂无消息");
    root.appendChild(empty);
    return;
  }

  for (const message of messages) {
    root.appendChild(renderAiChatMessage(message));
  }
}

function renderAiChatMessage(message: AiChatMessage): HTMLElement {
  const item = document.createElement("article");
  item.className = `ai-chat-message ${message.role}`;

  const label = document.createElement("div");
  label.className = "ai-chat-message-label";
  label.textContent = message.role === "user" ? tr("You", "你") : message.role === "tool" ? tr("Tool", "工具") : message.label;

  const bubble = document.createElement("div");
  bubble.className = "ai-chat-bubble";
  bubble.textContent = message.content || " ";

  item.appendChild(label);
  item.appendChild(bubble);
  return item;
}

function updateSurfaceCursor(view: SurfaceView, surfaceId: string): void {
  const selected = surfaceId === state.selectedSurfaceId;
  view.term.options.cursorBlink = selected;
  view.term.options.cursorInactiveStyle = selected ? "outline" : "none";
}

function applySurfaceInputPolicy(view: SurfaceView, surface: LayoutSurface | undefined): void {
  const supportsLease = surface?.terminalControl === true && surface.readOnly !== true;
  const held = surface !== undefined && terminalControl.leaseId(surface.id) !== undefined;
  view.term.options.disableStdin =
    surface?.kind === "ai_chat" || surface?.readOnly === true || (supportsLease && !held) || isViewModeInputBlocked();
  syncTerminalNativeInputGuard(view);

  const showHeader = supportsLease || !view.paneCloseButton.hidden;
  view.control.hidden = !showHeader;
  view.controlButton.hidden = !supportsLease;
  view.mount.toggleAttribute("data-terminal-lease", showHeader);
  if (!showHeader || !surface) return;
  const title = surface.title?.trim() || tr("Terminal", "终端");
  if (view.controlTitle.textContent !== title) {
    view.controlTitle.textContent = title;
    view.controlTitle.title = title;
    const close = tr(`Close ${title}`, `关闭「${title}」`);
    view.paneCloseButton.title = close;
    view.paneCloseButton.setAttribute("aria-label", close);
    const move = tr(`Drag ${title} to rearrange splits`, `拖动「${title}」调整分屏位置`);
    view.paneDragHandle.title = move;
    view.paneDragHandle.setAttribute("aria-label", move);
  }
  if (!supportsLease) return;
  const reason = terminalControl.reason(surface.id);
  const connected = terminalControl.isAvailable();
  const action = held ? tr("Release", "归还") : tr("Take control", "接管");
  if (view.controlButton.textContent !== action) view.controlButton.textContent = action;
  view.controlButton.classList.toggle("secondary-button", held);
  view.controlButton.disabled = !connected || reason === "unsupported";
}

function syncTerminalNativeInputGuard(view: SurfaceView): void {
  setNativeTerminalInputBlocked(view.host, view.term.options.disableStdin === true || isViewModeInputBlocked(), document.activeElement);
}

function isViewModeInputBlocked(): boolean {
  return shouldBlockNativeTerminalInput(isMobileRemoteShell(), state.mobileInputMode);
}

function fitOrResize(view: SurfaceView): void {
  if (view.queuedGridChanges > 0) return;
  const hasRemoteGridDimensions = view.remoteCols !== null && view.remoteRows !== null;
  const useViewportFit = shouldUseViewportFit(hasRemoteGridDimensions);
  if (!useViewportFit && view.remoteCols && view.remoteRows) {
    if (view.term.cols !== view.remoteCols || view.term.rows !== view.remoteRows) {
      view.term.resize(view.remoteCols, view.remoteRows);
    }
    return;
  }

  view.fit.fit();
}

function scheduleFit(view: SurfaceView): void {
  if (view.fitQueued) return;
  view.fitQueued = true;
  requestAnimationFrame(() => {
    view.fitQueued = false;
    if (!view.host.isConnected) return;
    try {
      fitOrResize(view);
      updateCanvasPan(view);
      placeTerminalGrid(view);
      view.term.refresh(0, Math.max(0, view.term.rows - 1));
    } catch {
      // xterm can briefly report zero-sized panels while layout is settling.
    }
  });
}

function placeTerminalGrid(view: SurfaceView): void {
  if (view.control.hidden) return;
  const screen = view.host.querySelector<HTMLElement>(".xterm-screen");
  if (!screen?.offsetWidth || !screen.offsetHeight) return;
  const viewport = view.host.getBoundingClientRect();
  if (!viewport.width || !viewport.height) return;
  const grid = { width: screen.offsetWidth, height: screen.offsetHeight };
  const { y, scale } = fitTerminalCanvas(viewport, grid, isMobileRemoteShell() ? state.mobileVisualZoom : 1);
  view.host.style.setProperty("--terminal-grid-width", `${grid.width}px`);
  view.host.style.setProperty("--terminal-grid-height", `${grid.height}px`);
  view.host.style.setProperty("--terminal-grid-zoom", String(scale));
  view.host.style.setProperty("--terminal-grid-top", `${y / scale}px`);
}

function applyInitialSnapshot(view: SurfaceView, surface: LayoutSurface): void {
  const snapshot = surface.snapshot;
  if (!snapshot) return;
  if (surface.kind === "ai_chat") {
    if (view.snapshotText === snapshot) return;
    view.snapshotText = snapshot;
    view.snapshotApplied = true;
    view.hasLiveOutput = false;
  } else {
    if (!shouldScheduleInitialSnapshotReplay({
      hasSnapshot: true,
      snapshotApplied: view.snapshotApplied,
      initialSnapshotPending: view.initialSnapshotPending,
      hasLiveOutput: view.hasLiveOutput,
    })) return;
    view.initialSnapshotPending = true;
    view.snapshotText = snapshot;
  }
  requestAnimationFrame(() => {
    if (!view.host.isConnected) {
      view.initialSnapshotPending = false;
      return;
    }
    try {
      fitOrResize(view);
      updateCanvasPan(view);
      placeTerminalGrid(view);
    } catch {
      // xterm can briefly report zero-sized panels while layout is settling.
    }
    view.term.reset();
    view.term.write(snapshot + cursorMoveSequence(surface));
    view.snapshotApplied = true;
    view.initialSnapshotPending = false;
    flushPendingOutput(view);
    view.term.refresh(0, Math.max(0, view.term.rows - 1));
  });
}

function writeSurfaceText(view: SurfaceView, text: string): void {
  if (!text) return;
  if (shouldBufferLiveOutputForInitialSnapshot({
    opened: view.opened,
    initialSnapshotPending: view.initialSnapshotPending,
  })) {
    bufferLiveOutput(view, text);
    return;
  }
  flushPendingOutput(view);
  view.term.write(text);
}

function flushPendingOutput(view: SurfaceView): void {
  if (!shouldFlushBufferedOutput({
    opened: view.opened,
    initialSnapshotPending: view.initialSnapshotPending,
    hasPendingOutput: view.pendingTerminalWrites.length > 0,
  })) return;
  const pending = view.pendingTerminalWrites;
  view.pendingTerminalWrites = [];
  view.bufferedOutputLength = 0;
  const surfaceId = view.panel.dataset.surfaceId!;
  for (const write of pending) {
    if (typeof write === "string") view.term.write(write);
    else applyTerminalGrid(surfaceId, write.cols, write.rows);
  }
}

function bufferLiveOutput(view: SurfaceView, text: string): void {
  const writes = view.pendingTerminalWrites;
  const previous = writes.at(-1);
  if (typeof previous === "string") writes[writes.length - 1] = previous + text;
  else writes.push(text);
  view.bufferedOutputLength += text.length;
  let lastDroppedGrid: { cols: number; rows: number } | undefined;
  while (view.bufferedOutputLength > PENDING_OUTPUT_LIMIT) {
    const first = writes[0];
    if (typeof first !== "string") {
      lastDroppedGrid = first;
      writes.shift();
      continue;
    }
    const excess = view.bufferedOutputLength - PENDING_OUTPUT_LIMIT;
    const remove = Math.min(first.length, excess);
    view.bufferedOutputLength -= remove;
    if (remove === first.length) writes.shift();
    else writes[0] = first.slice(remove);
  }
  if (lastDroppedGrid && typeof writes[0] === "string") writes.unshift(lastDroppedGrid);
}

function bindCanvasPan(view: SurfaceView): () => void {
  const mount = view.mount;
  const scrollbar = view.scrollbar;
  const scrollbarThumb = view.scrollbarThumb;
  let activePointerId: number | null = null;
  let startClient: CanvasPoint = { x: 0, y: 0 };
  let startPan: CanvasPoint = { x: 0, y: 0 };
  let lastHistoryClientY = 0;
  let dragged = false;
  let suppressClick = false;
  let suppressClickButton: number | null = null;
  let scrollbarPointerId: number | null = null;
  let scrollbarGrabOffset = 0;
  let pointerCaptureDeferred = false;

  const onPointerDown = (event: PointerEvent): void => {
    const dragInput = {
      mobile: isMobileRemoteShell(),
      isPrimary: event.isPrimary,
      button: event.button,
      nativeSelection: state.mobileInputMode === "view",
    };
    if (
      !shouldStartCanvasPanDrag(dragInput)
    ) return;
    const mobile = isMobileRemoteShell();
    updateCanvasPan(view);
    const viewport = canvasViewportSize(view);
    const canvas = canvasContentSize(view);
    const hasScrollableHistory = mobile && view.term.buffer.active.baseY > 0;
    if (canvas.width <= viewport.width && canvas.height <= viewport.height && !hasScrollableHistory) return;

    pointerCaptureDeferred = shouldDeferCanvasPanPointerDownDefault(dragInput);
    if (!pointerCaptureDeferred) event.preventDefault();
    activePointerId = event.pointerId;
    startClient = { x: event.clientX, y: event.clientY };
    lastHistoryClientY = event.clientY;
    startPan = view.canvasPan;
    dragged = false;
    if (!pointerCaptureDeferred) captureCanvasPointer(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (activePointerId !== event.pointerId) return;
    const delta = { x: event.clientX - startClient.x, y: event.clientY - startClient.y };
    if (!dragged && !isCanvasDrag(delta)) return;
    if (pointerCaptureDeferred) {
      pointerCaptureDeferred = false;
      captureCanvasPointer(event.pointerId);
    }
    if (isMobileRemoteShell() && Math.abs(delta.y) >= Math.abs(delta.x)) {
      const historyLines = touchHistoryScrollLines(event.clientY - lastHistoryClientY, terminalRowHeight(view));
      if (
        historyLines !== 0 &&
        terminalCanScrollHistory({
          baseY: view.term.buffer.active.baseY,
          viewportY: view.term.buffer.active.viewportY,
          deltaY: historyLines,
        })
      ) {
        dragged = true;
        event.preventDefault();
        view.term.scrollLines(historyLines);
        lastHistoryClientY = event.clientY;
        startClient = { x: event.clientX, y: event.clientY };
        startPan = view.canvasPan;
        return;
      }
    }
    dragged = true;
    event.preventDefault();
    const viewport = canvasViewportSize(view);
    const canvas = canvasContentSize(view);
    if (canvas.width <= viewport.width && canvas.height <= viewport.height) return;
    view.canvasPan = panCanvasBy(startPan, delta, viewport, canvas);
    applyCanvasPan(view);
    updateCanvasScrollbar(view);
  };

  const onWheel = (event: WheelEvent): void => {
    const hasRemoteGridDimensions = view.remoteCols !== null && view.remoteRows !== null;
    const mobile = isMobileRemoteShell();
    const useCanvasPan = shouldUseCanvasPan(hasRemoteGridDimensions);
    const canScrollHistory = terminalCanScrollHistory({
      baseY: view.term.buffer.active.baseY,
      viewportY: view.term.buffer.active.viewportY,
      deltaY: event.deltaY,
    });
    if (!shouldConsumeCanvasWheel({ mobile, useCanvasPan, terminalCanScrollHistory: canScrollHistory })) return;

    updateCanvasPan(view);
    const viewport = canvasViewportSize(view);
    const canvas = canvasContentSize(view);
    event.preventDefault();
    event.stopPropagation();
    if (canvas.width <= viewport.width && canvas.height <= viewport.height) return;

    const nextPan = panCanvasByWheel(
      view.canvasPan,
      wheelDelta(event, viewport),
      viewport,
      canvas,
    );
    if (nextPan.x === view.canvasPan.x && nextPan.y === view.canvasPan.y) return;

    view.canvasPan = nextPan;
    applyCanvasPan(view);
    updateCanvasScrollbar(view, viewport, canvas);
  };

  const finishPointer = (event: PointerEvent): void => {
    if (activePointerId !== event.pointerId) return;
    activePointerId = null;
    pointerCaptureDeferred = false;
    if (dragged) {
      suppressClick = true;
      suppressClickButton = event.button;
      event.preventDefault();
    }
    try {
      mount.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be gone after pointercancel.
    }
  };

  const captureCanvasPointer = (pointerId: number): void => {
    try {
      mount.setPointerCapture(pointerId);
    } catch {
      // Pointer capture can fail if the browser cancels the touch during layout changes.
    }
  };

  const onClick = (event: MouseEvent): void => {
    if (!suppressClick) return;
    suppressClick = false;
    suppressClickButton = null;
    event.preventDefault();
    event.stopPropagation();
  };

  const onAuxClick = (event: MouseEvent): void => {
    if (!suppressClick || event.button !== suppressClickButton) return;
    suppressClick = false;
    suppressClickButton = null;
    event.preventDefault();
    event.stopPropagation();
  };

  const applyScrollbarPointer = (event: PointerEvent): void => {
    const viewport = canvasViewportSize(view);
    const canvas = canvasContentSize(view);
    const trackRect = scrollbar.getBoundingClientRect();
    const nextThumbTop = event.clientY - trackRect.top - scrollbarGrabOffset;
    view.canvasPan = {
      x: view.canvasPan.x,
      y: panYFromVerticalScrollbarThumb(nextThumbTop, trackRect.height, viewport, canvas),
    };
    applyCanvasPan(view);
    updateCanvasScrollbar(view, viewport, canvas);
  };

  const onScrollbarPointerDown = (event: PointerEvent): void => {
    if (isMobileRemoteShell() || scrollbar.dataset.visible !== "true" || !event.isPrimary) return;
    event.preventDefault();
    event.stopPropagation();
    scrollbarPointerId = event.pointerId;
    const thumbRect = scrollbarThumb.getBoundingClientRect();
    scrollbarGrabOffset =
      event.target === scrollbarThumb
        ? event.clientY - thumbRect.top
        : thumbRect.height / 2;
    applyScrollbarPointer(event);
    try {
      scrollbar.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can fail if the browser cancels during layout changes.
    }
  };

  const onScrollbarPointerMove = (event: PointerEvent): void => {
    if (scrollbarPointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    applyScrollbarPointer(event);
  };

  const finishScrollbarPointer = (event: PointerEvent): void => {
    if (scrollbarPointerId !== event.pointerId) return;
    scrollbarPointerId = null;
    event.preventDefault();
    event.stopPropagation();
    try {
      scrollbar.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be gone after pointercancel.
    }
  };

  mount.addEventListener("pointerdown", onPointerDown);
  mount.addEventListener("pointermove", onPointerMove);
  mount.addEventListener("pointerup", finishPointer);
  mount.addEventListener("pointercancel", finishPointer);
  mount.addEventListener("click", onClick, true);
  mount.addEventListener("auxclick", onAuxClick, true);
  mount.addEventListener("wheel", onWheel, CANVAS_WHEEL_EVENT_OPTIONS);
  scrollbar.addEventListener("pointerdown", onScrollbarPointerDown);
  scrollbar.addEventListener("pointermove", onScrollbarPointerMove);
  scrollbar.addEventListener("pointerup", finishScrollbarPointer);
  scrollbar.addEventListener("pointercancel", finishScrollbarPointer);

  return () => {
    mount.removeEventListener("pointerdown", onPointerDown);
    mount.removeEventListener("pointermove", onPointerMove);
    mount.removeEventListener("pointerup", finishPointer);
    mount.removeEventListener("pointercancel", finishPointer);
    mount.removeEventListener("click", onClick, true);
    mount.removeEventListener("auxclick", onAuxClick, true);
    mount.removeEventListener("wheel", onWheel, CANVAS_WHEEL_EVENT_OPTIONS);
    scrollbar.removeEventListener("pointerdown", onScrollbarPointerDown);
    scrollbar.removeEventListener("pointermove", onScrollbarPointerMove);
    scrollbar.removeEventListener("pointerup", finishScrollbarPointer);
    scrollbar.removeEventListener("pointercancel", finishScrollbarPointer);
  };
}

function terminalRowHeight(view: SurfaceView): number {
  const screen = view.host.querySelector<HTMLElement>(".xterm-screen");
  const height = screen?.getBoundingClientRect().height ?? 0;
  return height > 0 && view.term.rows > 0 ? height / view.term.rows : 18;
}

function resetCanvasPan(view: SurfaceView): void {
  view.canvasPan = { x: 0, y: 0 };
  view.lastCanvasViewport = null;
  applyCanvasPan(view);
  hideCanvasScrollbar(view);
}

function updateCanvasPan(view: SurfaceView): void {
  const hasRemoteGridDimensions = view.remoteCols !== null && view.remoteRows !== null;
  if (!shouldUseCanvasPan(hasRemoteGridDimensions)) {
    view.needsDefaultCanvasPan = false;
    resetCanvasPan(view);
    return;
  }
  const viewport = canvasViewportSize(view);
  const canvas = canvasContentSize(view);
  if (viewport.width <= 0 || viewport.height <= 0 || canvas.width <= 0 || canvas.height <= 0) return;
  const bottomGutter = terminalCanvasBottomGutter(view, isMobileRemoteShell());
  if (view.needsDefaultCanvasPan) {
    view.canvasPan = defaultCanvasPan(viewport, canvas, { bottomGutter });
    view.needsDefaultCanvasPan = false;
  } else {
    view.canvasPan = resizeCanvasPan({
      pan: view.canvasPan,
      previousViewport: view.lastCanvasViewport,
      viewport,
      canvas,
      bottomGutter,
    });
  }
  view.lastCanvasViewport = viewport;
  applyCanvasPan(view);
  updateCanvasScrollbar(view, viewport, canvas, bottomGutter);
}

function applyCanvasPan(view: SurfaceView): void {
  const mode = isMobileRemoteShell() ? "transform" : "scroll";
  const renderState = canvasPanRenderState(view.canvasPan, mode);
  view.host.style.transform = renderState.transform;
  view.host.scrollLeft = renderState.scrollLeft;
  view.host.scrollTop = renderState.scrollTop;
  if (mode === "scroll") {
    view.canvasPan = {
      x: -view.host.scrollLeft,
      y: -view.host.scrollTop,
    };
  }
}

function updateCanvasScrollbar(
  view: SurfaceView,
  viewport: CanvasSize = canvasViewportSize(view),
  canvas: CanvasSize = canvasContentSize(view),
  bottomGutter: number = terminalCanvasBottomGutter(view, isMobileRemoteShell()),
): void {
  const hasRemoteGridDimensions = view.remoteCols !== null && view.remoteRows !== null;
  const mobile = isMobileRemoteShell();
  if (!shouldUseCanvasPan(hasRemoteGridDimensions)) {
    hideCanvasScrollbar(view);
    return;
  }

  const verticalInset = mobile ? MOBILE_SCROLLBAR_VERTICAL_INSET : DESKTOP_SCROLLBAR_VERTICAL_INSET;
  const trackHeight =
    view.scrollbar.clientHeight ||
    Math.max(0, view.mount.clientHeight - verticalInset * 2);
  const metrics = verticalScrollbarMetrics(view.canvasPan, viewport, canvas, trackHeight, {
    bottomGutter,
    minThumbHeight: mobile ? MOBILE_SCROLLBAR_MIN_THUMB_HEIGHT : DESKTOP_SCROLLBAR_MIN_THUMB_HEIGHT,
  });
  if (!metrics.visible) {
    hideCanvasScrollbar(view);
    return;
  }

  view.scrollbar.dataset.visible = "true";
  view.scrollbar.setAttribute("aria-hidden", "false");
  view.scrollbarThumb.style.height = `${metrics.thumbHeight}px`;
  view.scrollbarThumb.style.transform = `translateY(${metrics.thumbTop}px)`;
}

function hideCanvasScrollbar(view: SurfaceView): void {
  view.scrollbar.dataset.visible = "false";
  view.scrollbar.setAttribute("aria-hidden", "true");
  view.scrollbarThumb.style.height = "";
  view.scrollbarThumb.style.transform = "";
}

function canvasViewportSize(view: SurfaceView): CanvasSize {
  return {
    width: view.host.clientWidth,
    height: view.host.clientHeight,
  };
}

function terminalCanvasBottomGutter(view: SurfaceView, mobile: boolean): number {
  return mobile && view.control.hidden ? MOBILE_CANVAS_BOTTOM_GUTTER : 0;
}

function canvasContentSize(view: SurfaceView): CanvasSize {
  if (!view.control.hidden) return canvasViewportSize(view);
  const screen = view.host.querySelector<HTMLElement>(".xterm-screen");
  const xterm = view.host.querySelector<HTMLElement>(".xterm");
  const terminalHeight = terminalCanvasHeight(view, screen);
  const rawSize = {
    width: Math.max(
      view.host.clientWidth,
      view.host.offsetWidth,
      view.host.scrollWidth,
      xterm?.offsetWidth ?? 0,
      xterm?.scrollWidth ?? 0,
      screen?.offsetWidth ?? 0,
      screen?.scrollWidth ?? 0,
    ),
    height: terminalHeight,
  };
  return scaleVisualCanvasSize(rawSize, isMobileRemoteShell() ? state.mobileVisualZoom : 1);
}

function terminalCanvasHeight(view: SurfaceView, screen: HTMLElement | null): number {
  const measuredHeight = Math.max(
    screen?.offsetHeight ?? 0,
    screen?.scrollHeight ?? 0,
  );
  if (measuredHeight <= 0) {
    const xterm = view.host.querySelector<HTMLElement>(".xterm");
    return Math.max(
      view.host.offsetHeight,
      view.host.scrollHeight,
      xterm?.offsetHeight ?? 0,
      xterm?.scrollHeight ?? 0,
    );
  }

  const buffer = view.term.buffer.active;
  return meaningfulTerminalCanvasHeight({
    measuredHeight,
    rows: view.term.rows,
    cursorY: buffer.cursorY,
    lastNonBlankRow: lastNonBlankTerminalRow(view),
  });
}

function lastNonBlankTerminalRow(view: SurfaceView): number {
  const buffer = view.term.buffer.active;
  const rows = Math.max(0, view.term.rows);
  for (let row = rows - 1; row >= 0; row -= 1) {
    const line = buffer.getLine(buffer.baseY + row);
    if (line && line.translateToString(true).trim().length > 0) return row;
  }
  return Math.max(0, Math.min(rows - 1, buffer.cursorY));
}

function wheelDelta(event: WheelEvent, viewport: CanvasSize): CanvasPoint {
  const scale =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 24
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? viewport.height
        : 1;
  return { x: event.deltaX * scale, y: event.deltaY * scale };
}

function bindTwoFingerMiddleClick(view: SurfaceView): () => void {
  const host = view.host;
  const MOVE_THRESHOLD = 14;
  const TIME_THRESHOLD = 700;
  let active = false;
  let startTime = 0;
  let centroid: { x: number; y: number } | null = null;

  const onTouchStart = (event: TouchEvent): void => {
    if (event.touches.length === 2) {
      active = true;
      startTime = Date.now();
      const a = event.touches[0];
      const b = event.touches[1];
      centroid = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
    } else if (event.touches.length > 2) {
      active = false;
      centroid = null;
    }
  };

  const onTouchMove = (event: TouchEvent): void => {
    if (!active || !centroid) return;
    if (event.touches.length !== 2) {
      active = false;
      return;
    }
    const a = event.touches[0];
    const b = event.touches[1];
    const cx = (a.clientX + b.clientX) / 2;
    const cy = (a.clientY + b.clientY) / 2;
    if (Math.hypot(cx - centroid.x, cy - centroid.y) > MOVE_THRESHOLD) {
      active = false;
    }
  };

  const onTouchEnd = (event: TouchEvent): void => {
    if (!active || !centroid) {
      if (event.touches.length === 0) {
        active = false;
        centroid = null;
      }
      return;
    }
    if (event.touches.length >= 2) return;
    const within = Date.now() - startTime <= TIME_THRESHOLD;
    const point = centroid;
    active = false;
    centroid = null;
    if (!within) return;
    event.preventDefault();
    dispatchMiddleClick(host, point.x, point.y);
  };

  const onTouchCancel = (): void => {
    active = false;
    centroid = null;
  };

  host.addEventListener("touchstart", onTouchStart, { passive: true });
  host.addEventListener("touchmove", onTouchMove, { passive: true });
  host.addEventListener("touchend", onTouchEnd, { passive: false });
  host.addEventListener("touchcancel", onTouchCancel, { passive: true });

  return () => {
    host.removeEventListener("touchstart", onTouchStart);
    host.removeEventListener("touchmove", onTouchMove);
    host.removeEventListener("touchend", onTouchEnd);
    host.removeEventListener("touchcancel", onTouchCancel);
  };
}

function dispatchMiddleClick(host: HTMLElement, clientX: number, clientY: number): void {
  const target =
    host.querySelector<HTMLElement>(".xterm-screen") ??
    host.querySelector<HTMLElement>(".xterm") ??
    host;
  const baseInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX,
    clientY,
    screenX: clientX,
    screenY: clientY,
    button: 1,
  };
  target.dispatchEvent(new MouseEvent("mousedown", { ...baseInit, buttons: 4 }));
  target.dispatchEvent(new MouseEvent("mouseup", { ...baseInit, buttons: 0 }));
  target.dispatchEvent(new MouseEvent("auxclick", { ...baseInit, buttons: 0, detail: 1 }));
}
