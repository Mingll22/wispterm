// Wire validation only: the desktop owns revision and surface membership checks.
export type WorkspaceNode = { surfaceId: string } | { axis: "x" | "y"; ratio: number };
type WorkspaceBase = { type: "workspace-action"; requestId: string };
type WorkspaceTarget = { tabId: string; layoutRevision: string };
export type WorkspaceAction =
  | (WorkspaceBase & { action: "create-tab" })
  | (WorkspaceBase & WorkspaceTarget & { action: "add-pane" | "close-pane"; surfaceId: string })
  | (WorkspaceBase & WorkspaceTarget & { action: "close-tab" })
  | (WorkspaceBase & WorkspaceTarget & { action: "set-layout"; splitTree: WorkspaceNode[] });
export type WorkspaceResult = {
  type: "workspace-action-result";
  requestId: string;
  status: "ok" | "stale" | "unsupported" | "protected" | "limit" | "failed" | "offline";
  tabId?: string;
  surfaceId?: string;
};

type RecordValue = Record<string, unknown>;
const statuses = new Set(["ok", "stale", "unsupported", "protected", "limit", "failed"]);
const record = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
export const isWorkspaceId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{16}(?![\s\S])/.test(value);
const requestId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}(?![\s\S])/.test(value);

export function parseWorkspaceTree(value: unknown): WorkspaceNode[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 127) return null;
  let slots = 1;
  const result: WorkspaceNode[] = [];
  for (const node of value) {
    if (slots === 0 || !record(node)) return null;
    slots--;
    if (isWorkspaceId(node.surfaceId) && Object.keys(node).length === 1) {
      result.push({ surfaceId: node.surfaceId });
    } else if ((node.axis === "x" || node.axis === "y") && typeof node.ratio === "number" &&
        Number.isFinite(node.ratio) && node.ratio > 0 && node.ratio < 1 && Object.keys(node).length === 2) {
      result.push({ axis: node.axis, ratio: node.ratio });
      slots += 2;
    } else return null;
  }
  return slots === 0 ? result : null;
}

export function browserWorkspaceAction(value: unknown, clientId: string): (WorkspaceAction & { clientId: string }) | null {
  if (!record(value) || value.type !== "workspace-action" || !requestId(value.requestId)) return null;
  const base = { type: "workspace-action" as const, requestId: value.requestId, clientId };
  if (value.action === "create-tab") {
    if (value.tabId !== undefined || value.layoutRevision !== undefined || value.surfaceId !== undefined || value.splitTree !== undefined) return null;
    return { ...base, action: "create-tab" };
  }
  if (!isWorkspaceId(value.tabId) || !isWorkspaceId(value.layoutRevision)) return null;
  const target = { tabId: value.tabId, layoutRevision: value.layoutRevision };
  if (value.action === "add-pane" || value.action === "close-pane") {
    if (!isWorkspaceId(value.surfaceId) || value.splitTree !== undefined) return null;
    return { ...base, ...target, action: value.action, surfaceId: value.surfaceId };
  }
  if (value.action === "close-tab") {
    if (value.surfaceId !== undefined || value.splitTree !== undefined) return null;
    return { ...base, ...target, action: "close-tab" };
  }
  if (value.action === "set-layout") {
    if (value.surfaceId !== undefined) return null;
    const splitTree = parseWorkspaceTree(value.splitTree);
    return splitTree ? { ...base, ...target, action: "set-layout", splitTree } : null;
  }
  return null;
}

export function hostWorkspaceResult(value: unknown): (WorkspaceResult & { clientId: string }) | null {
  if (!record(value) || value.type !== "workspace-action-result" || !requestId(value.requestId) ||
      typeof value.clientId !== "string" || value.clientId.length === 0 || value.clientId.length > 64 ||
      typeof value.status !== "string" || !statuses.has(value.status) ||
      (value.tabId !== undefined && !isWorkspaceId(value.tabId)) || (value.surfaceId !== undefined && !isWorkspaceId(value.surfaceId))) return null;
  return {
    type: "workspace-action-result", requestId: value.requestId, clientId: value.clientId,
    status: value.status as Exclude<WorkspaceResult["status"], "offline">,
    ...(value.tabId === undefined ? {} : { tabId: value.tabId as string }),
    ...(value.surfaceId === undefined ? {} : { surfaceId: value.surfaceId as string }),
  };
}
