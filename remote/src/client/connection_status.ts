import type { ConnectionStatus, StatusKind } from "./types";

export const HIGH_LATENCY_THRESHOLD_MS = 500;

export function connectionStatusForLatency(latencyMs: number): ConnectionStatus {
  const normalized = normalizeLatency(latencyMs);
  const kind: StatusKind = normalized > HIGH_LATENCY_THRESHOLD_MS ? "high-latency" : "online";
  const label = kind === "high-latency" ? "高延迟" : "低延迟";
  return {
    kind,
    text: `${label} · ${normalized} ms`,
    latencyMs: normalized,
    detail: latencyDisclosureText(normalized),
  };
}

export function connectionStatusWithoutPeer(latencyMs: number | null): ConnectionStatus {
  if (latencyMs === null) {
    return {
      kind: "offline",
      text: "桌面端未连接",
      latencyMs: null,
      detail: "暂无延迟数据",
    };
  }

  const normalized = normalizeLatency(latencyMs);
  return {
    kind: "offline",
    text: `桌面端未连接 · 中继延迟 ${normalized} ms`,
    latencyMs: normalized,
    detail: `中继延迟 ${normalized} ms`,
  };
}

export function connectionStatusConnecting(text = "正在连接…"): ConnectionStatus {
  return {
    kind: "connecting",
    text,
    latencyMs: null,
    detail: "暂无延迟数据",
  };
}

export function connectionStatusOffline(text = "连接已断开"): ConnectionStatus {
  return {
    kind: "offline",
    text,
    latencyMs: null,
    detail: "暂无延迟数据",
  };
}

export function latencyDisclosureText(latencyMs: number | null): string {
  if (latencyMs === null) return "暂无延迟数据";
  return `延迟 ${normalizeLatency(latencyMs)} ms`;
}

function normalizeLatency(latencyMs: number): number {
  if (!Number.isFinite(latencyMs)) return 0;
  return Math.max(0, Math.round(latencyMs));
}
