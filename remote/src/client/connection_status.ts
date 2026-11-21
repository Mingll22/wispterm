import { tr } from "./i18n";
import type { ConnectionStatus, StatusKind } from "./types";

export const HIGH_LATENCY_THRESHOLD_MS = 500;

export function connectionStatusForLatency(latencyMs: number): ConnectionStatus {
  const normalized = normalizeLatency(latencyMs);
  const kind: StatusKind = normalized > HIGH_LATENCY_THRESHOLD_MS ? "high-latency" : "online";
  const label = kind === "high-latency" ? tr("High latency", "高延迟") : tr("Low latency", "低延迟");
  return {
    kind,
    relay: "online",
    desktop: "online",
    text: `${label} · ${normalized} ms`,
    latencyMs: normalized,
    detail: latencyDisclosureText(normalized),
  };
}

export function connectionStatusWithoutPeer(latencyMs: number | null): ConnectionStatus {
  if (latencyMs === null) {
    return {
      kind: "offline",
      relay: "online",
      desktop: "offline",
      text: tr("Not connected", "桌面端未连接"),
      latencyMs: null,
      detail: tr("Latency unavailable", "暂无延迟数据"),
    };
  }

  const normalized = normalizeLatency(latencyMs);
  return {
    kind: "offline",
    relay: "online",
    desktop: "offline",
    text: tr(`Not connected · relay ${normalized} ms`, `桌面端未连接 · 中继延迟 ${normalized} ms`),
    latencyMs: normalized,
    detail: tr(`Relay latency: ${normalized} ms`, `中继延迟 ${normalized} ms`),
  };
}

export function connectionStatusConnecting(text = tr("Connecting...", "正在连接…")): ConnectionStatus {
  return {
    kind: "connecting",
    relay: "connecting",
    desktop: "unknown",
    text,
    latencyMs: null,
    detail: tr("Latency unavailable", "暂无延迟数据"),
  };
}

export function connectionStatusOffline(text = tr("Disconnected", "连接已断开")): ConnectionStatus {
  return {
    kind: "offline",
    relay: "offline",
    desktop: "unknown",
    text,
    latencyMs: null,
    detail: tr("Latency unavailable", "暂无延迟数据"),
  };
}

export function connectionStatusWaitingForDesktop(): ConnectionStatus {
  return {
    kind: "connecting",
    relay: "online",
    desktop: "unknown",
    text: tr("Checking desktop connection…", "正在确认桌面端…"),
    latencyMs: null,
    detail: tr("Latency unavailable", "暂无延迟数据"),
  };
}

export function connectionStatusMeasuringLatency(): ConnectionStatus {
  return {
    kind: "connecting",
    relay: "online",
    desktop: "online",
    text: tr("Connected · measuring latency…", "已连接 · 正在测量延迟…"),
    latencyMs: null,
    detail: tr("Latency unavailable", "暂无延迟数据"),
  };
}

export function latencyDisclosureText(latencyMs: number | null): string {
  if (latencyMs === null) return tr("Latency unavailable", "暂无延迟数据");
  return tr(`Latency: ${normalizeLatency(latencyMs)} ms`, `延迟 ${normalizeLatency(latencyMs)} ms`);
}

function normalizeLatency(latencyMs: number): number {
  if (!Number.isFinite(latencyMs)) return 0;
  return Math.max(0, Math.round(latencyMs));
}
