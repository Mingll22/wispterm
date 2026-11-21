import { tr } from "./i18n";
import type { LayoutSurface } from "./types";

export function aiChatStopControlState(surface: LayoutSurface, connected: boolean): { disabled: boolean; label: string } {
  if (surface.requestStopping) return { disabled: true, label: tr("Stopping", "正在停止…") };
  const hasRuntimeState = typeof surface.requestInflight === "boolean";
  return {
    disabled: !connected || (hasRuntimeState && surface.requestInflight !== true),
    label: tr("Stop", "停止"),
  };
}
