import { tr } from "./i18n";
import type { ConnectionStatus, LayoutTab, MeResponse, RelayMessage } from "./types";
import { isWorkspaceId, type WorkspaceAction, type WorkspaceResult } from "../workspace_protocol";
import type { TabControlRequest } from "../tab_control_protocol";
import { state, currentTab, inputLeaseId, tabControlId } from "./state";
import { isLayoutMessage, normalizeLayout, resolveLayoutSelection } from "./layout";
import { decodeHex, encodeHex, safeJson, validPositiveInteger } from "./utils";
import { saveSessionKey } from "./storage";
import {
  isTerminalControlReason,
  setTerminalControlSender,
  terminalControl,
  TERMINAL_LEASE_RENEW_INTERVAL_MS,
  type TerminalControlRequest,
} from "./terminal_control";
import { setTabControlSender, tabControl } from "./tab_control";
import {
  connectionStatusConnecting,
  connectionStatusForLatency,
  connectionStatusMeasuringLatency,
  connectionStatusOffline,
  connectionStatusWaitingForDesktop,
  connectionStatusWithoutPeer,
} from "./connection_status";
import {
  applyTerminalGrid,
  disposeSurfaceViews,
  reconcileSurfaceViews,
  refitAllSurfaces,
  writeLegacyOutput,
  writeSurfaceBytes,
} from "./surfaces";

const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_WATCHDOG_MS = 50_000;
const RECONNECT_MIN_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const WORKSPACE_ACTION_TIMEOUT_MS = 10_000;

type ActionBody<T> = T extends WorkspaceAction ? Omit<T, "type" | "requestId" | "leaseId"> : never;
export type WorkspaceCommand = ActionBody<WorkspaceAction>;
export type WorkspaceActionStatus = WorkspaceResult["status"] | "timeout";

type TransportHooks = {
  onWorkspaceChanged: () => void;
  onInputUiChanged: () => void;
  setStatus: (status: ConnectionStatus) => void;
};

let hooks: TransportHooks = {
  onWorkspaceChanged: () => {
    // wired by views/console
  },
  onInputUiChanged: () => {
    // wired by views/console
  },
  setStatus: () => {
    // wired by views/console
  },
};

export function setTransportHooks(next: TransportHooks): void {
  hooks = next;
}

const encoder = new TextEncoder();
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let leaseTimer: ReturnType<typeof setInterval> | null = null;
let lastMessageAt = 0;
let lastPingSentAt = 0;
let lastLatencyMs: number | null = null;
let wisptermPeerConnected: boolean | null = null;
let pendingWorkspaceAction: {
  request: WorkspaceAction;
  timer: ReturnType<typeof setTimeout>;
  finish: (status: WorkspaceActionStatus) => void;
  created?: { tabId: string; surfaceId: string };
} | null = null;

function sendControlRequest(request: TerminalControlRequest | TabControlRequest): boolean {
  const ws = state.socket;
  if (!wisptermPeerConnected || ws?.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(request));
    return true;
  } catch {
    return false;
  }
}
setTerminalControlSender(sendControlRequest);
setTabControlSender(sendControlRequest);

export function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
}

export async function loadMe(): Promise<MeResponse> {
  try {
    const res = await api("/api/me");
    if (!res.ok) return { authenticated: false };
    return (await res.json()) as MeResponse;
  } catch {
    return { authenticated: false };
  }
}

export function connect(sessionKey: string): void {
  if (!sessionKey) return;
  state.activeSessionKey = sessionKey;
  cancelReconnect();
  stopHeartbeat();
  releaseRemoteControl();
  connectRemoteControl(null);
  state.socket?.close();
  finishWorkspaceAction("offline");
  disposeSurfaceViews();
  state.layoutState = null;
  state.selectedSurfaceId = null;
  state.hasSeenLayout = false;
  resetConnectionHealth();
  saveSessionKey(sessionKey);
  hooks.onWorkspaceChanged();
  hooks.onInputUiChanged();

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${location.host}/ws/browser?session=${encodeURIComponent(sessionKey)}`);
  state.socket = ws;
  hooks.setStatus(connectionStatusConnecting(tr("Connecting...", "正在连接…")));
  hooks.onInputUiChanged();

  ws.addEventListener("open", () => {
    if (state.socket !== ws) return;
    reconnectAttempts = 0;
    updateConnectionStatus();
    hooks.onInputUiChanged();
    startHeartbeat(ws);
  });

  ws.addEventListener("close", () => {
    const wasActive = state.socket === ws;
    if (!wasActive) return;
    stopHeartbeat();
    state.socket = null;
    finishWorkspaceAction("offline");
    connectRemoteControl(null);
    resetConnectionHealth();
    if (state.activeSessionKey === sessionKey) {
      scheduleReconnect();
    } else {
      hooks.setStatus(connectionStatusOffline());
    }
    hooks.onInputUiChanged();
  });

  ws.addEventListener("error", () => {
    if (state.socket === ws) {
      try { ws.close(); } catch { /* ignore */ }
    }
  });

  ws.addEventListener("message", (event) => {
    if (state.socket !== ws) return;
    if (typeof event.data !== "string") return;
    lastMessageAt = Date.now();
    const message = safeJson(event.data);
    if (!message) return;

    if (message.type === "pong" || message.type === "ping") {
      if (message.type === "ping") safeSocketSend(ws, { type: "pong" });
      else updateLatencyFromPong(message);
      return;
    }

    if (message.type === "terminal-control-client" && typeof message.clientId === "string") {
      connectRemoteControl(message.clientId);
      hooks.onInputUiChanged();
      return;
    }

    if (message.type === "terminal-control-state" &&
        typeof message.surfaceId === "string" &&
        (message.clientId === null || typeof message.clientId === "string") &&
        isTerminalControlReason(message.reason)) {
      const leaseId = validPositiveInteger(message.leaseId);
      if (terminalControl.receive(
        message.surfaceId, message.clientId, leaseId, message.reason, document.visibilityState === "visible",
      )) {
        hooks.onInputUiChanged();
        if (message.reason === "expired") refitAllSurfaces();
      }
      return;
    }

    if (message.type === "tab-control-state" &&
        isWorkspaceId(message.tabId) &&
        (message.clientId === null || typeof message.clientId === "string") &&
        isTerminalControlReason(message.reason)) {
      if (tabControl.receive({
        type: message.type, tabId: message.tabId, clientId: message.clientId,
        leaseId: validPositiveInteger(message.leaseId), reason: message.reason,
      }, document.visibilityState === "visible")) {
        hooks.onInputUiChanged();
        if (message.reason === "expired") refitAllSurfaces();
      }
      return;
    }

    if (message.type === "terminal-grid" && typeof message.surfaceId === "string") {
      const cols = validPositiveInteger(message.cols);
      const rows = validPositiveInteger(message.rows);
      if (cols !== null && rows !== null) applyTerminalGrid(message.surfaceId, cols, rows);
      return;
    }

    if (message.type === "peer-status") {
      wisptermPeerConnected = message.wisptermConnected === true;
      if (!wisptermPeerConnected) {
        terminalControl.setDesktopReady(false);
        tabControl.setDesktopReady(false);
        finishWorkspaceAction("offline");
      }
      updateConnectionStatus();
      hooks.onInputUiChanged();
      return;
    }

    if (message.type === "workspace-action-result") {
      receiveWorkspaceActionResult(message);
      return;
    }

    if (isLayoutMessage(message)) {
      wisptermPeerConnected = true;
      terminalControl.setDesktopReady(true);
      const previousTab = state.hasSeenLayout ? currentTab() : null;
      state.layoutState = normalizeLayout(message);
      tabControl.setDesktopReady(state.layoutState.tabControl === true);
      const selection = resolveLayoutSelection(state.layoutState, previousTab, state.selectedSurfaceId);
      state.hasSeenLayout = true;
      state.selectedTabIndex = selection.tabIndex;
      state.selectedSurfaceId = selection.surfaceId;
      selectCreatedWorkspacePane();
      updateConnectionStatus();
      reconcileSurfaceViews();
      hooks.onWorkspaceChanged();
      return;
    }

    if (message.type === "output" && typeof message.data === "string") {
      writeLegacyOutput(message.data);
    } else if (
      message.type === "output-bytes" &&
      message.encoding === "hex" &&
      typeof message.data === "string"
    ) {
      const surfaceId = typeof message.surfaceId === "string" ? message.surfaceId : state.selectedSurfaceId;
      const bytes = decodeHex(message.data);
      if (surfaceId && bytes) writeSurfaceBytes(surfaceId, bytes);
    }
  });
}

export function disconnect(): void {
  state.activeSessionKey = null;
  cancelReconnect();
  stopHeartbeat();
  reconnectAttempts = 0;
  releaseRemoteControl();
  connectRemoteControl(null);
  finishWorkspaceAction("offline");
  if (state.socket) {
    try { state.socket.close(); } catch { /* ignore */ }
    state.socket = null;
  }
  resetConnectionHealth();
  hooks.setStatus(connectionStatusOffline());
}

export function releaseRemoteControl(): void {
  terminalControl.reconcile([], false);
  tabControl.reconcile(null, [], [], false);
}

function connectRemoteControl(clientId: string | null): void {
  terminalControl.connect(clientId);
  tabControl.connect(clientId);
}

export function workspaceActionAvailable(tab?: LayoutTab): boolean {
  const controlId = tab && tabControlId(tab);
  return wisptermPeerConnected === true && state.socket?.readyState === WebSocket.OPEN &&
    state.layoutState?.workspaceActions === true && pendingWorkspaceAction === null &&
    (!controlId || tabControl.leaseId(controlId) !== undefined);
}

export function sendWorkspaceAction(command: WorkspaceCommand): Promise<WorkspaceActionStatus> {
  const socket = state.socket;
  if (!socket || !workspaceActionAvailable()) return Promise.resolve("offline");
  const requestId = Array.from(crypto.getRandomValues(new Uint32Array(4)), (word) => word.toString(16).padStart(8, "0")).join("");
  let leaseId: number | undefined;
  if (command.action === "rename-tab" && !state.layoutState?.tabRename) return Promise.resolve("unsupported");
  if (command.action !== "create-tab" && command.action !== "rename-tab" && state.layoutState?.tabControl) {
    leaseId = tabControl.leaseId(command.tabId);
    if (leaseId === undefined) return Promise.resolve("denied");
  }
  const request: WorkspaceAction = {
    type: "workspace-action", requestId, ...command, ...(leaseId === undefined ? {} : { leaseId }),
  };
  return new Promise((finish) => {
    const timer = setTimeout(() => finishWorkspaceAction("timeout"), WORKSPACE_ACTION_TIMEOUT_MS);
    pendingWorkspaceAction = { request, timer, finish };
    try {
      socket.send(JSON.stringify(request));
    } catch {
      finishWorkspaceAction("offline");
    }
  });
}

function finishWorkspaceAction(status: WorkspaceActionStatus): void {
  const pending = pendingWorkspaceAction;
  if (!pending) return;
  pendingWorkspaceAction = null;
  clearTimeout(pending.timer);
  pending.finish(status);
}

function receiveWorkspaceActionResult(message: RelayMessage): void {
  const pending = pendingWorkspaceAction;
  if (!pending || message.requestId !== pending.request.requestId) return;
  switch (message.status) {
    case "ok":
      if (pending.request.action === "create-tab" || pending.request.action === "add-pane") {
        if (!isWorkspaceId(message.tabId) || !isWorkspaceId(message.surfaceId)) {
          finishWorkspaceAction("failed");
          return;
        }
        pending.created = { tabId: message.tabId, surfaceId: message.surfaceId };
        if (selectCreatedWorkspacePane()) hooks.onWorkspaceChanged();
      } else {
        finishWorkspaceAction("ok");
      }
      return;
    case "stale":
    case "unsupported":
    case "protected":
    case "denied":
    case "limit":
    case "failed":
    case "offline":
      finishWorkspaceAction(message.status);
  }
}

function selectCreatedWorkspacePane(): boolean {
  const created = pendingWorkspaceAction?.created;
  if (!created) return false;
  const tab = state.layoutState?.tabs.find((entry) => entry.workspace?.tabId === created.tabId);
  if (!tab?.surfaces.some((surface) => surface.id === created.surfaceId)) return false;
  state.selectedTabIndex = tab.index;
  state.selectedSurfaceId = created.surfaceId;
  finishWorkspaceAction("ok");
  return true;
}

export function sendInputBytes(surfaceId: string, data: string): void {
  const ws = state.socket;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const tab = state.layoutState?.tabs.find((entry) => entry.surfaces.some((surface) => surface.id === surfaceId));
  const surface = tab?.surfaces.find((entry) => entry.id === surfaceId);
  if (!surface || surface.readOnly) return;
  const leaseId = inputLeaseId(surfaceId, tab);
  if ((surface.terminalControl || tabControlId(tab)) &&
      (leaseId === undefined || document.visibilityState !== "visible")) return;
  ws.send(
    JSON.stringify({
      type: "input-bytes",
      surfaceId,
      leaseId,
      encoding: "hex",
      data: encodeHex(encoder.encode(data)),
    }),
  );
}

export function kickReconnectIfIdle(): void {
  if (!state.activeSessionKey) return;
  const ws = state.socket;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  cancelReconnect();
  reconnectAttempts = 0;
  connect(state.activeSessionKey);
}

function startHeartbeat(ws: WebSocket): void {
  stopHeartbeat();
  lastMessageAt = Date.now();
  sendHeartbeatPing(ws);
  pingTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    sendHeartbeatPing(ws);
  }, HEARTBEAT_INTERVAL_MS);
  leaseTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN || document.visibilityState !== "visible") return;
    terminalControl.renew();
    tabControl.renew();
  }, TERMINAL_LEASE_RENEW_INTERVAL_MS);
  watchdogTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastMessageAt > HEARTBEAT_WATCHDOG_MS) {
      try { ws.close(4000, "heartbeat timeout"); } catch { /* ignore */ }
    }
  }, 5_000);
}

function stopHeartbeat(): void {
  if (leaseTimer !== null) {
    clearInterval(leaseTimer);
    leaseTimer = null;
  }
  if (pingTimer !== null) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (watchdogTimer !== null) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

function scheduleReconnect(): void {
  if (!state.activeSessionKey) return;
  cancelReconnect();
  const exponent = Math.min(reconnectAttempts, 5);
  const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_MIN_DELAY_MS * 2 ** exponent);
  reconnectAttempts += 1;
  hooks.setStatus(connectionStatusConnecting(tr(`Reconnecting in ${Math.round(delay / 1000)}s...`, `${Math.round(delay / 1000)} 秒后重新连接…`)));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (state.activeSessionKey) connect(state.activeSessionKey);
  }, delay);
}

function cancelReconnect(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function safeSocketSend(ws: WebSocket, payload: unknown): void {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // Ignore — close handler will retry via reconnect.
  }
}

function sendHeartbeatPing(ws: WebSocket): void {
  lastPingSentAt = Date.now();
  safeSocketSend(ws, { type: "ping", at: lastPingSentAt });
}

function updateLatencyFromPong(message: { at?: unknown }): void {
  const sentAt = typeof message.at === "number" ? message.at : lastPingSentAt;
  if (sentAt <= 0) return;
  lastLatencyMs = Date.now() - sentAt;
  updateConnectionStatus();
}

function updateConnectionStatus(): void {
  const ws = state.socket;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    hooks.setStatus(connectionStatusOffline());
    return;
  }
  if (wisptermPeerConnected === null) {
    hooks.setStatus(connectionStatusWaitingForDesktop());
    return;
  }
  if (!wisptermPeerConnected) {
    hooks.setStatus(connectionStatusWithoutPeer(lastLatencyMs));
    return;
  }
  if (lastLatencyMs === null) {
    hooks.setStatus(connectionStatusMeasuringLatency());
    return;
  }
  hooks.setStatus(connectionStatusForLatency(lastLatencyMs));
}

function resetConnectionHealth(): void {
  lastPingSentAt = 0;
  lastLatencyMs = null;
  wisptermPeerConnected = null;
  terminalControl.setDesktopReady(false);
  tabControl.setDesktopReady(false);
}
