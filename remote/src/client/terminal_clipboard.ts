import type { Terminal } from "@xterm/xterm";
import { tr } from "./i18n";
import type { TerminalImageStatus } from "../server/terminal_image_protocol";

export type ImagePasteOutcome = TerminalImageStatus | "too-large" | "busy" | "timeout";

export function bindTerminalClipboard(term: Terminal, host: HTMLElement, pasteImage: (file: File) => void): void {
  // Let the browser deliver its paste event instead of asking the remote
  // application to read the clipboard of a different machine.
  term.attachCustomKeyEventHandler((event) => !(
    event.type === "keydown" && !event.isComposing && !event.altKey &&
    (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v"
  ));
  host.addEventListener("paste", (event) => {
    const image = Array.from(event.clipboardData?.items ?? [])
      .find((item) => item.kind === "file" && item.type.startsWith("image/"))?.getAsFile() ??
      Array.from(event.clipboardData?.files ?? []).find((file) => file.type.startsWith("image/"));
    if (!image) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    pasteImage(image);
  }, { capture: true });
}

export async function reportTerminalImagePaste(send: () => Promise<ImagePasteOutcome>): Promise<void> {
  const output = document.querySelector<HTMLOutputElement>("#workspace-action-status");
  const waiting = tr("Sending image…", "正在发送图片…");
  if (output) output.textContent = waiting;
  const status = await send();
  if (!output?.isConnected || output.textContent !== waiting || status === "busy") return;
  switch (status) {
    case "queued": output.textContent = ""; break;
    case "denied": output.textContent = tr("Take control of this terminal before pasting an image.", "接管当前终端后再粘贴图片。"); break;
    case "unsupported": output.textContent = tr("This terminal doesn't support image paste.", "当前终端暂不支持粘贴图片。"); break;
    case "too-large": output.textContent = tr("Images must be 4 MB or smaller.", "图片大小不能超过 4 MB。"); break;
    case "invalid": output.textContent = tr("Paste a PNG or JPEG image.", "请粘贴 PNG 或 JPEG 图片。"); break;
    case "offline": output.textContent = tr("Reconnect to WispTerm to paste an image.", "重新连接 WispTerm 后再粘贴图片。"); break;
    case "timeout": output.textContent = tr("WispTerm did not confirm the image transfer.", "WispTerm 未确认收到图片。"); break;
    case "failed": output.textContent = tr("The image could not be pasted.", "图片粘贴失败。"); break;
  }
}
