// Relay validation only. Lease ownership and expiration belong to the desktop.
import { isWorkspaceId, validLeaseId } from "./workspace_protocol.js";

type Message = Record<string, unknown>;
export type TabControlGrid = { surfaceId: string; cols: number; rows: number };
export type TabControlReason = "acquired" | "taken" | "released" | "expired" | "desktop" | "denied" | "unsupported";
export type TabControlRequest =
  | { type: "tab-control"; tabId: string; action: "acquire" | "takeover" }
  | { type: "tab-control"; tabId: string; action: "renew" | "release"; leaseId: number }
  | { type: "tab-control"; tabId: string; action: "resize"; leaseId: number; grids: TabControlGrid[] };
export type TabControlState = {
  type: "tab-control-state"; tabId: string; clientId: string | null; leaseId: number | null; reason: TabControlReason;
};
export type TerminalGridMessage = { type: "terminal-grid"; surfaceId: string; cols: number; rows: number };
type TerminalControlStateMessage = {
  type: "terminal-control-state";
  surfaceId: string;
  clientId: string | null;
  leaseId: number | null;
  reason: string;
};

function record(value: unknown): value is Message {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function surfaceId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validGrid(cols: unknown, rows: unknown): cols is number {
  return typeof cols === "number" && Number.isInteger(cols) && cols >= 2 && cols <= 512 &&
    typeof rows === "number" && Number.isInteger(rows) && rows >= 1 && rows <= 256;
}

export function browserTerminalMessage(value: unknown, clientId: string): Message | null {
  if (!record(value) || !surfaceId(value.surfaceId)) return null;
  if (value.type === "input-bytes" && typeof value.data === "string") {
    if (value.leaseId !== undefined && !validLeaseId(value.leaseId)) return null;
    return {
      type: "input-bytes", surfaceId: value.surfaceId, encoding: value.encoding,
      data: value.data, clientId, ...(value.leaseId === undefined ? {} : { leaseId: value.leaseId }),
    };
  }
  if (value.type !== "terminal-control") return null;
  const action = value.action;
  if (action !== "acquire" && action !== "takeover" && action !== "renew" && action !== "release" && action !== "resize") return null;
  if ((action === "renew" || action === "release" || action === "resize") && !validLeaseId(value.leaseId)) return null;
  if ((action === "acquire" || action === "takeover" || action === "resize") && !validGrid(value.cols, value.rows)) return null;
  return {
    type: "terminal-control", surfaceId: value.surfaceId, action, clientId,
    ...((action === "renew" || action === "release" || action === "resize") ? { leaseId: value.leaseId } : {}),
    ...((action === "acquire" || action === "takeover" || action === "resize") ? { cols: value.cols, rows: value.rows } : {}),
  };
}

function validHostGridDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 0xffff;
}

const reasons = new Set(["acquired", "taken", "released", "expired", "desktop", "denied", "unsupported"]);

export function browserTabControl(value: unknown, clientId: string): (TabControlRequest & { clientId: string }) | null {
  if (!record(value) || value.type !== "tab-control" || !isWorkspaceId(value.tabId)) return null;
  const base = { type: "tab-control" as const, tabId: value.tabId, clientId };
  if (value.action === "acquire" || value.action === "takeover") return { ...base, action: value.action };
  if (!validLeaseId(value.leaseId)) return null;
  if (value.action === "renew" || value.action === "release") return { ...base, action: value.action, leaseId: value.leaseId };
  if (value.action !== "resize" || !Array.isArray(value.grids) || value.grids.length < 1 || value.grids.length > 16) return null;
  const ids = new Set<string>();
  const grids: TabControlGrid[] = [];
  for (const grid of value.grids) {
    if (!record(grid) || !isWorkspaceId(grid.surfaceId) || ids.has(grid.surfaceId) || !validGrid(grid.cols, grid.rows)) return null;
    ids.add(grid.surfaceId);
    grids.push({ surfaceId: grid.surfaceId, cols: grid.cols, rows: grid.rows as number });
  }
  return { ...base, action: "resize", leaseId: value.leaseId, grids };
}

export function hostTabControlState(value: unknown): TabControlState | null {
  if (!record(value) || value.type !== "tab-control-state" || !isWorkspaceId(value.tabId) ||
      !(value.clientId === null || (typeof value.clientId === "string" && value.clientId.length > 0)) ||
      !(value.leaseId === null || validLeaseId(value.leaseId)) ||
      typeof value.reason !== "string" || !reasons.has(value.reason)) return null;
  return { type: value.type, tabId: value.tabId, clientId: value.clientId, leaseId: value.leaseId, reason: value.reason as TabControlReason };
}

export function hostTerminalMessage(value: unknown): TerminalGridMessage | TerminalControlStateMessage | null {
  if (!record(value) || !surfaceId(value.surfaceId)) return null;
  if (value.type === "terminal-grid" && validHostGridDimension(value.cols) && validHostGridDimension(value.rows)) {
    return { type: value.type, surfaceId: value.surfaceId, cols: value.cols, rows: value.rows };
  }
  if (value.type === "terminal-control-state" &&
      (value.clientId === null || (typeof value.clientId === "string" && value.clientId.length > 0)) &&
      (value.leaseId === null || validLeaseId(value.leaseId)) &&
      typeof value.reason === "string" && reasons.has(value.reason)) {
    return { type: value.type, surfaceId: value.surfaceId, clientId: value.clientId, leaseId: value.leaseId, reason: value.reason };
  }
  return null;
}
