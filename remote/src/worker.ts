import { DurableObject } from "cloudflare:workers";
import { browserWorkspaceAction, hostWorkspaceResult } from "./server/workspace_protocol.js";
import { browserTabControl, hostTabControlState, browserTerminalMessage, hostTerminalMessage, type TerminalGridMessage } from "./server/terminal_control_protocol.js";

type Env = {
  ASSETS: Fetcher;
  REMOTE_SESSION: DurableObjectNamespace<RemoteSession>;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD_HASH: string;
  SESSION_SIGNING_SECRET: string;
};

type LoginBody = {
  username?: string;
  password?: string;
};

type RelayMessage = {
  type?: string;
  at?: number;
  data?: string;
  encoding?: string;
  surfaceId?: string;
  message?: string;
  wisptermConnected?: boolean;
};

const COOKIE_NAME = "wispterm_remote";
const SESSION_TTL_SECONDS = 24 * 60 * 60;

export class RemoteSession extends DurableObject<Env> {
  private wispterm: WebSocket | null = null;
  private browsers = new Map<string, WebSocket>();
  private lastLayout: RelayMessage | null = null;
  private gridsSinceLayout = new Map<string, TerminalGridMessage>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("upgrade") !== "websocket") {
      return json({ error: "websocket required" }, 426);
    }

    const role = url.searchParams.get("role");
    if (role !== "browser" && role !== "wispterm") {
      return json({ error: "invalid role" }, 400);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.accept();

    if (role === "wispterm") {
      this.attachWispTerm(server);
    } else {
      this.attachBrowser(server);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private attachWispTerm(socket: WebSocket): void {
    this.wispterm?.close(1012, "replaced by a new WispTerm connection");
    this.wispterm = socket;
    this.gridsSinceLayout.clear();
    this.broadcast({ type: "notice", message: "WispTerm connected" });
    this.broadcastPeerStatus();

    socket.addEventListener("message", (event) => {
      if (this.wispterm !== socket || typeof event.data !== "string") return;
      const message = safeJson(event.data);
      if (!message) return;

      if (message.type === "ping") {
        try { socket.send(JSON.stringify(pongMessage(message))); } catch { /* ignore */ }
        return;
      }
      if (message.type === "pong") return;

      if (message.type === "workspace-action-result") {
        const result = hostWorkspaceResult(message);
        if (result) {
          const { clientId, ...browserResult } = result;
          this.sendBrowser(clientId, browserResult);
        }
        return;
      }
      if (message.type === "output" && typeof message.data === "string") {
        this.broadcast({ type: "output", data: message.data });
      } else if (message.type === "output-bytes" && typeof message.data === "string") {
        this.broadcast({
          type: "output-bytes",
          surfaceId: message.surfaceId,
          encoding: message.encoding,
          data: message.data,
        });
      } else if (message.type === "tab-control-state") {
        const state = hostTabControlState(message);
        if (state) this.broadcast(state);
      } else if (message.type === "terminal-control-state" || message.type === "terminal-grid") {
        const terminalMessage = hostTerminalMessage(message);
        if (terminalMessage) {
          if (terminalMessage.type === "terminal-grid") this.gridsSinceLayout.set(terminalMessage.surfaceId, terminalMessage);
          this.broadcast(terminalMessage);
        }
      } else if (message.type === "layout") {
        this.lastLayout = message;
        this.gridsSinceLayout.clear();
        this.broadcast(message);
      }
    });

    socket.addEventListener("close", () => {
      if (this.wispterm !== socket) return;
      this.wispterm = null;
      this.broadcast({ type: "notice", message: "WispTerm disconnected" });
      this.broadcastPeerStatus();
    });
  }

  private attachBrowser(socket: WebSocket): void {
    const clientId = crypto.randomUUID();
    this.browsers.set(clientId, socket);
    this.sendBrowser(clientId, { type: "terminal-control-client", clientId });
    this.sendBrowser(clientId, { type: "notice", message: "Browser paired; input enabled" });
    // Cached layout first, peer status last (see server/session.ts): a stale
    // layout must not leave an offline host looking connected.
    if (this.lastLayout) this.sendBrowser(clientId, this.lastLayout);
    for (const grid of this.gridsSinceLayout.values()) this.sendBrowser(clientId, grid);
    if (this.wispterm) this.sendBrowser(clientId, { type: "notice", message: "WispTerm connected" });
    this.sendPeerStatus(clientId);

    socket.addEventListener("message", (event) => {
      if (this.browsers.get(clientId) !== socket || typeof event.data !== "string") return;
      const message = safeJson(event.data);
      if (!message) return;

      if (message.type === "ping") {
        this.sendBrowser(clientId, pongMessage(message));
        return;
      }
      if (message.type === "pong") return;

      if (message.type === "workspace-action") {
        const action = browserWorkspaceAction(message, clientId);
        if (action && (!this.wispterm || !safeSend(this.wispterm, action))) {
          this.sendBrowser(clientId, { type: "workspace-action-result", requestId: action.requestId, status: "offline" });
        }
        return;
      }
      const terminalMessage = browserTabControl(message, clientId) ?? browserTerminalMessage(message, clientId);
      if (terminalMessage && this.wispterm) this.wispterm.send(JSON.stringify(terminalMessage));
    });

    socket.addEventListener("close", () => {
      this.browsers.delete(clientId);
    });
  }

  private broadcast(message: object): void {
    const payload = JSON.stringify(message);
    for (const clientId of this.browsers.keys()) this.sendBrowserPayload(clientId, payload);
  }

  private sendBrowser(clientId: string, message: unknown): void {
    this.sendBrowserPayload(clientId, JSON.stringify(message));
  }

  private sendBrowserPayload(clientId: string, payload: string): void {
    const socket = this.browsers.get(clientId);
    if (!socket) return;
    if (socket.readyState !== 1) {
      this.browsers.delete(clientId);
      return;
    }
    try {
      socket.send(payload);
    } catch {
      this.browsers.delete(clientId);
    }
  }

  private sendPeerStatus(clientId: string): void {
    this.sendBrowser(clientId, { type: "peer-status", wisptermConnected: this.wispterm !== null });
  }

  private broadcastPeerStatus(): void {
    this.broadcast({ type: "peer-status", wisptermConnected: this.wispterm !== null });
  }
}

function safeSend(socket: WebSocket, message: unknown): boolean {
  if (socket.readyState !== 1) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function pongMessage(message: RelayMessage): RelayMessage {
  return typeof message.at === "number" ? { type: "pong", at: message.at } : { type: "pong" };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/login" && request.method === "POST") {
      return login(request, env);
    }
    if (url.pathname === "/api/logout" && request.method === "POST") {
      return logout();
    }
    if (url.pathname === "/api/me" && request.method === "GET") {
      const session = await readSession(request, env);
      return json(session ? { authenticated: true, username: session.username } : { authenticated: false });
    }
    if (url.pathname === "/ws/browser") {
      const session = await readSession(request, env);
      if (!session) return json({ error: "login required" }, 401);
      return routeWebSocket(request, env, "browser");
    }
    if (url.pathname === "/ws/wispterm") {
      // Phase 1 scaffold: the future WispTerm client must add device
      // challenge/response before this route is trusted for production.
      return routeWebSocket(request, env, "wispterm");
    }

    return env.ASSETS.fetch(request);
  },
};

async function login(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as LoginBody | null;
  const username = (body?.username ?? "").trim();
  const password = body?.password ?? "";

  if (username !== env.ADMIN_USERNAME.trim()) {
    return json({ error: "invalid credentials" }, 401);
  }

  const ok = await verifyPassword(password, env.ADMIN_PASSWORD_HASH);
  if (!ok) return json({ error: "invalid credentials" }, 401);

  const now = Math.floor(Date.now() / 1000);
  const token = await signSession(env, {
    username,
    exp: now + SESSION_TTL_SECONDS,
  });

  return json(
    { authenticated: true, username },
    200,
    {
      "set-cookie": `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`,
    },
  );
}

function logout(): Response {
  return json(
    { authenticated: false },
    200,
    {
      "set-cookie": `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
    },
  );
}

async function routeWebSocket(request: Request, env: Env, role: "browser" | "wispterm"): Promise<Response> {
  if (request.headers.get("upgrade") !== "websocket") {
    return json({ error: "websocket required" }, 426);
  }

  const url = new URL(request.url);
  const sessionKey = url.searchParams.get("session")?.trim();
  if (!sessionKey) return json({ error: "session key required" }, 400);

  const id = env.REMOTE_SESSION.idFromName(sessionKey);
  const stub = env.REMOTE_SESSION.get(id);
  const target = new URL(request.url);
  target.searchParams.set("role", role);
  return stub.fetch(new Request(target, request));
}

async function verifyPassword(password: string, expectedHash: string): Promise<boolean> {
  const [scheme, hash] = expectedHash.trim().split(":", 2);
  if (scheme.toLowerCase() !== "sha256" || !hash) return false;
  const actual = await sha256Hex(password);
  return timingSafeEqual(actual, hash.trim().toLowerCase());
}

type SessionPayload = {
  username: string;
  exp: number;
};

async function readSession(request: Request, env: Env): Promise<SessionPayload | null> {
  const cookie = request.headers.get("cookie") ?? "";
  const token = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);

  if (!token) return null;

  const [payloadPart, sigPart] = token.split(".", 2);
  if (!payloadPart || !sigPart) return null;

  const expected = await hmacHex(env.SESSION_SIGNING_SECRET, payloadPart);
  if (!timingSafeEqual(expected, sigPart)) return null;

  const payload = JSON.parse(decodeBase64Url(payloadPart)) as SessionPayload;
  if (!payload.username || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

async function signSession(env: Env, payload: SessionPayload): Promise<string> {
  const payloadPart = encodeBase64Url(JSON.stringify(payload));
  const sig = await hmacHex(env.SESSION_SIGNING_SECRET, payloadPart);
  return `${payloadPart}.${sig}`;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return hex(new Uint8Array(digest));
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return hex(new Uint8Array(sig));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function safeJson(data: string): RelayMessage | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as RelayMessage : null;
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}
