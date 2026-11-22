import { isWorkspaceId, validLeaseId } from "./workspace_protocol.js";

export const MAX_TERMINAL_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_TERMINAL_IMAGE_BYTES / 3) * 4;

export type TerminalImageMime = "image/png" | "image/jpeg";
export type TerminalImageStatus = "queued" | "invalid" | "unsupported" | "denied" | "failed" | "offline";
type Message = Record<string, unknown>;

export function isTerminalImageMime(value: unknown): value is TerminalImageMime {
  return value === "image/png" || value === "image/jpeg";
}

export function isTerminalImageStatus(value: unknown): value is TerminalImageStatus {
  return value === "queued" || value === "invalid" || value === "unsupported" ||
    value === "denied" || value === "failed" || value === "offline";
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}(?![\s\S])/.test(value);
}

function validImageData(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_BASE64_LENGTH ||
      value.length % 4 !== 0 || !/^[a-zA-Z0-9+/]+={0,2}(?![\s\S])/.test(value)) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length * 3 / 4 - padding <= MAX_TERMINAL_IMAGE_BYTES;
}

export function browserTerminalImage(value: Message, clientId: string) {
  const { type, requestId, surfaceId, leaseId, mime, data } = value;
  if (type !== "terminal-image-paste" || !validId(requestId) || !isWorkspaceId(surfaceId) ||
      !validLeaseId(leaseId) || !isTerminalImageMime(mime) || !validImageData(data)) return null;
  return { type, requestId, surfaceId, leaseId, mime, data, clientId };
}

export function hostTerminalImageResult(value: Message) {
  const { type, requestId, clientId, status } = value;
  if (type !== "terminal-image-paste-result" || !validId(requestId) || !validId(clientId) ||
      !isTerminalImageStatus(status) || status === "offline") return null;
  return { type, requestId, clientId, status };
}
