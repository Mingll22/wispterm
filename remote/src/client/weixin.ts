import { tr } from "./i18n";
import { maskSessionKey } from "./storage";

export type WeixinSettings = {
  enabled: boolean;
  target_session: string;
  reply_timeout_ms: number;
};

export type WeixinBindingSummary = {
  bound: boolean;
  user_id?: string;
  account_id?: string;
  base_url?: string;
  bound_at?: string;
};

export type WeixinSettingsResponse = {
  settings: WeixinSettings;
  binding: WeixinBindingSummary;
  sessions: Array<{ key: string; connected: boolean }>;
};

export type WeixinSaveSettingsResponse = {
  success: boolean;
  settings: WeixinSettings;
};

export type WeixinBindStartResponse = {
  qrcode: string;
  qrcode_content: string;
  qrcode_data_url: string;
  status: string;
};

function weixinApi(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
}

async function weixinApiJson<T>(res: Response, fallback: string): Promise<T> {
  if (res.ok) return (await res.json()) as T;

  let errorMessage = "";
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) {
      errorMessage = body.error;
    }
  } catch {
    // Ignore invalid or empty error bodies and use the endpoint-specific fallback.
  }

  if (errorMessage) throw new Error(errorMessage);
  throw new Error(fallback);
}

async function throwWeixinApiError(res: Response, fallback: string): Promise<never> {
  await weixinApiJson<unknown>(res, fallback);
  throw new Error(fallback);
}

export function normalizeWeixinSettings(input: Partial<WeixinSettings>): WeixinSettings {
  return {
    enabled: input.enabled === true,
    target_session: String(input.target_session ?? "").trim(),
    reply_timeout_ms: Number.isFinite(input.reply_timeout_ms) ? Number(input.reply_timeout_ms) : 120000,
  };
}

export function bridgeStatusText(settings: WeixinSettings, binding: WeixinBindingSummary): string {
  if (!binding.bound) return tr("Not bound · scan to bind Weixin", "未绑定 · 请扫码绑定微信");
  if (!settings.enabled) return tr("Bound · turn on Bridge", "已绑定 · 请启用微信直连");

  const parts = [tr("Bound", "已绑定")];
  if (settings.target_session) parts.push(maskSessionKey(settings.target_session));
  parts.push(tr("/ping to test", "发送 /ping 测试"));
  return parts.join(" · ");
}

export function bindActionText(binding: WeixinBindingSummary): string {
  return binding.bound ? tr("Unbind", "解绑") : tr("Bind", "绑定");
}

export function weixinBindStatusText(status: string, detail = ""): string {
  switch (status) {
    case "wait": return tr("Scan the QR code with Weixin", "请使用微信扫码");
    case "scaned": return tr("Scanned. Confirm in Weixin", "已扫码，请在微信中确认");
    case "bound":
    case "confirmed": return tr("Bound successfully", "绑定成功");
    case "expired": return tr("QR code expired. Start binding again", "二维码已过期，请重新绑定");
    case "failed": return tr("Bind failed", "绑定失败");
    default: return detail || tr("Waiting for Weixin confirmation...", "等待微信确认…");
  }
}

export function weixinErrorText(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  switch (error.message) {
    case "login required": return tr("Sign in again", "请重新登录");
    case "invalid json": return tr("Invalid settings", "设置格式无效");
    case "weixin qrcode unavailable": return tr("Could not load the Weixin QR code", "暂时无法获取微信二维码");
    case "qrcode required": return tr("Missing QR code. Start binding again", "缺少微信二维码，请重新绑定");
    case "weixin qrcode status unavailable": return tr("Could not check Weixin scan status", "暂时无法获取微信扫码状态");
    case "confirmed weixin binding missing bot_token": return tr("Weixin did not return a binding token. Start binding again", "微信未返回绑定凭据，请重新绑定");
    case "not found": return tr("Weixin Direct is unavailable", "未找到微信直连功能");
    default: return error.message || fallback;
  }
}

export async function fetchWeixinSettings(): Promise<WeixinSettingsResponse> {
  const res = await weixinApi("/api/weixin/settings");
  return weixinApiJson<WeixinSettingsResponse>(res, tr("Load failed", "加载失败"));
}

export async function saveWeixinSettings(settings: WeixinSettings): Promise<WeixinSaveSettingsResponse> {
  const res = await weixinApi("/api/weixin/settings", { method: "PUT", body: JSON.stringify(settings) });
  return weixinApiJson<WeixinSaveSettingsResponse>(res, tr("Save failed", "保存失败"));
}

export async function startWeixinBind(): Promise<WeixinBindStartResponse> {
  const res = await weixinApi("/api/weixin/bind/start", { method: "POST" });
  return weixinApiJson<WeixinBindStartResponse>(res, tr("Bind failed", "绑定失败"));
}

export async function pollWeixinBindStatus(
  qrcode: string,
): Promise<{ status: string; message?: string; binding: WeixinBindingSummary }> {
  const res = await weixinApi(`/api/weixin/bind/status?qrcode=${encodeURIComponent(qrcode)}`);
  return weixinApiJson<{ status: string; message?: string; binding: WeixinBindingSummary }>(
    res,
    tr("Check failed", "检查绑定状态失败"),
  );
}

export async function unbindWeixin(): Promise<void> {
  const res = await weixinApi("/api/weixin/bind", { method: "DELETE" });
  if (!res.ok) await throwWeixinApiError(res, tr("Unbind failed", "解绑失败"));
}
