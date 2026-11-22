import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { RemoteSession } from "../../src/server/session.js";
import * as workspaceProtocol from "../../src/server/workspace_protocol.js";
import * as terminalProtocol from "../../src/server/terminal_control_protocol.js";

class Socket {
  readyState = 1;
  sent: string[] = [];
  listeners = new Map<string, Array<(data: any) => void>>();
  send(data: string): void { this.sent.push(data); }
  close(): void {}
  on(event: string, callback: (data: any) => void): void { this.add(event, callback); }
  addEventListener(event: string, callback: (data: any) => void): void { this.add(event, callback); }
  private add(event: string, callback: (data: any) => void): void {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(callback);
    this.listeners.set(event, handlers);
  }
  receive(message: unknown, worker: boolean): void {
    const data = JSON.stringify(message);
    for (const callback of this.listeners.get("message") ?? []) callback(worker ? { data } : data);
  }
  messages(): Record<string, unknown>[] { return this.sent.map((s) => JSON.parse(s)); }
}

function workerSession(): { attachWispTerm(s: Socket): void; attachBrowser(s: Socket): void } {
  const source = readFileSync(new URL("../../src/worker.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, any> = {};
  runInNewContext(code, {
    exports, crypto: { randomUUID },
    require(name: string) {
      if (name === "cloudflare:workers") return { DurableObject: class {} };
      if (name === "./server/workspace_protocol.js") return workspaceProtocol;
      if (name === "./server/terminal_control_protocol.js") return terminalProtocol;
      throw new Error(`unexpected import ${name}`);
    },
  });
  return new exports.RemoteSession();
}

for (const worker of [false, true]) test(`${worker ? "Worker" : "Node"} relays tab control and validates both directions`, () => {
  const session = worker ? workerSession() : new RemoteSession("tab-test");
  const host = new Socket(), a = new Socket(), b = new Socket();
  session.attachWispTerm(host as never);
  session.attachBrowser(a as never);
  session.attachBrowser(b as never);
  const aId = a.messages()[0].clientId, bId = b.messages()[0].clientId;
  const tabId = "0123456789abcdef", surfaceId = "fedcba9876543210";
  const send = (socket: Socket, message: unknown) => socket.receive(message, worker);
  const layout = { type: "layout", tabControl: true, workspaceActions: true, tabs: [] };
  send(host, layout);
  assert.deepEqual(a.messages().at(-1), layout);
  const late = new Socket();
  session.attachBrowser(late as never);
  assert.deepEqual(late.messages().find((message) => message.type === "layout"), layout);

  send(a, { type: "tab-control", tabId, action: "acquire", clientId: bId });
  send(a, { type: "tab-control", tabId, action: "takeover" });
  send(a, { type: "tab-control", tabId, action: "renew", leaseId: 0xffffffff });
  send(a, { type: "tab-control", tabId, action: "release", leaseId: 1 });
  send(a, { type: "tab-control", tabId, action: "resize", leaseId: 1, clientId: bId, grids: [{ surfaceId, cols: 2, rows: 256, ignored: true }] });
  assert.deepEqual(host.messages(), [
    { type: "tab-control", tabId, action: "acquire", clientId: aId },
    { type: "tab-control", tabId, action: "takeover", clientId: aId },
    { type: "tab-control", tabId, action: "renew", clientId: aId, leaseId: 0xffffffff },
    { type: "tab-control", tabId, action: "release", clientId: aId, leaseId: 1 },
    { type: "tab-control", tabId, action: "resize", clientId: aId, leaseId: 1, grids: [{ surfaceId, cols: 2, rows: 256 }] },
  ]);
  const beforeInvalid = host.sent.length;
  const grid = { surfaceId, cols: 80, rows: 24 };
  for (const message of [
    { action: "acquire", tabId: "bad" }, { action: "other" }, { action: "renew" },
    { action: "release", leaseId: 0 }, { action: "renew", leaseId: 0x100000000 },
    { action: "resize", leaseId: 1, grids: [] },
    { action: "resize", leaseId: 1, grids: Array.from({ length: 17 }, (_, i) => ({ ...grid, surfaceId: i.toString(16).padStart(16, "0") })) },
    { action: "resize", leaseId: 1, grids: [grid, grid] },
    { action: "resize", leaseId: 1, grids: [{ ...grid, surfaceId: "bad" }] },
    ...[{ cols: 1 }, { cols: 513 }, { cols: 2.5 }, { rows: 0 }, { rows: 257 }].map((bad) => ({ action: "resize", leaseId: 1, grids: [{ ...grid, ...bad }] })),
  ]) send(a, { type: "tab-control", tabId, ...message });
  assert.equal(host.sent.length, beforeInvalid);
  const grids = Array.from({ length: 16 }, (_, i) => ({ surfaceId: i.toString(16).padStart(16, "0"), cols: 512, rows: 1 }));
  send(a, { type: "tab-control", tabId, action: "resize", leaseId: 1, grids });
  assert.equal((host.messages().at(-1)?.grids as unknown[]).length, 16);

  const beforeA = a.sent.length, beforeB = b.sent.length;
  send(a, { type: "tab-control-state", tabId, clientId: aId, leaseId: 1, reason: "acquired" });
  send(host, { type: "tab-control-state", tabId, clientId: aId, leaseId: 0, reason: "acquired" });
  send(host, { type: "tab-control-state", tabId, clientId: aId, leaseId: 1, reason: "bogus" });
  send(host, { type: "tab-control-state", tabId, clientId: aId, leaseId: 1, reason: "acquired", ignored: true });
  send(host, { type: "tab-control-state", tabId, clientId: null, leaseId: null, reason: "released" });
  const expected = [
    { type: "tab-control-state", tabId, clientId: aId, leaseId: 1, reason: "acquired" },
    { type: "tab-control-state", tabId, clientId: null, leaseId: null, reason: "released" },
  ];
  assert.deepEqual(a.messages().slice(beforeA), expected);
  assert.deepEqual(b.messages().slice(beforeB), expected);

  const action = { type: "workspace-action", requestId: "r", action: "close-tab", tabId, layoutRevision: tabId, leaseId: 7, clientId: bId };
  send(a, action);
  assert.deepEqual(host.messages().at(-1), { ...action, clientId: aId });
  const afterAction = host.sent.length;
  send(a, { ...action, leaseId: 0 });
  send(a, { type: "workspace-action", requestId: "r", action: "create-tab", leaseId: 1 });
  assert.equal(host.sent.length, afterAction);
  const beforeResult = a.sent.length;
  send(host, { type: "workspace-action-result", requestId: "r", clientId: aId, status: "denied" });
  assert.deepEqual(a.messages().slice(beforeResult), [{ type: "workspace-action-result", requestId: "r", status: "denied" }]);
});
