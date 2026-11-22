import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as workspaceProtocol from "../../src/server/workspace_protocol.js";
import * as terminalProtocol from "../../src/server/terminal_control_protocol.js";
import * as imageProtocol from "../../src/server/terminal_image_protocol.js";

// Exercise the actual Worker relay handlers with lightweight Cloudflare/WebSocket doubles.
function workerSession(): { attachWispTerm(s: WorkerSocket): void; attachBrowser(s: WorkerSocket): void } {
  const source = readFileSync(new URL("../../src/worker.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, any> = {};
  runInNewContext(code, {
    exports, crypto: { randomUUID },
    require(name: string) {
      if (name === "cloudflare:workers") return { DurableObject: class {} };
      if (name === "./server/workspace_protocol.js") return workspaceProtocol;
      if (name === "./server/terminal_control_protocol.js") return terminalProtocol;
      if (name === "./server/terminal_image_protocol.js") return imageProtocol;
      throw new Error(`unexpected import ${name}`);
    },
  });
  return new exports.RemoteSession();
}

class WorkerSocket {
  readyState = 1;
  fail = false;
  sent: string[] = [];
  listeners = new Map<string, Array<(event: { data: string }) => void>>();
  send(value: string): void {
    if (this.fail) throw new Error("send failed");
    this.sent.push(value);
  }
  close(): void {}
  addEventListener(event: string, callback: (event: { data: string }) => void): void {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(callback);
    this.listeners.set(event, handlers);
  }
  receive(value: unknown): void {
    for (const callback of this.listeners.get("message") ?? []) callback({ data: JSON.stringify(value) });
  }
  messages(): Array<Record<string, unknown>> { return this.sent.map((value) => JSON.parse(value)); }
}

test("Worker stamps workspace identity and routes valid results to that browser only", () => {
  const session = workerSession(), host = new WorkerSocket(), a = new WorkerSocket(), b = new WorkerSocket();
  session.attachWispTerm(host);
  session.attachBrowser(a);
  session.attachBrowser(b);
  const aId = a.messages()[0].clientId, bId = b.messages()[0].clientId;
  const beforeA = a.sent.length, beforeB = b.sent.length;
  a.receive({ type: "workspace-action", requestId: "worker_1", action: "create-tab", clientId: bId });
  assert.deepEqual(host.messages().at(-1), { type: "workspace-action", requestId: "worker_1", action: "create-tab", clientId: aId });
  host.receive({ type: "workspace-action-result", requestId: "worker_1", status: "ok", clientId: aId, tabId: "0000000000000001" });
  assert.deepEqual(a.messages().slice(beforeA), [{ type: "workspace-action-result", requestId: "worker_1", status: "ok", tabId: "0000000000000001" }]);
  assert.equal(b.sent.length, beforeB);
  host.receive({ type: "workspace-action-result", requestId: "worker_1", status: "invalid", clientId: aId });
  assert.equal(a.sent.length, beforeA + 1);
  const hostCount = host.sent.length;
  a.receive({ type: "workspace-action", requestId: "worker_2", action: "set-layout", tabId: "0000000000000001", layoutRevision: "0000000000000001", splitTree: [{ axis: "x", ratio: 0.5 }] });
  assert.equal(host.sent.length, hostCount);
});


test("Worker forwards image paste using its relay identity and returns the result only to the sender", () => {
  const session = workerSession(), host = new WorkerSocket(), sender = new WorkerSocket(), observer = new WorkerSocket();
  session.attachWispTerm(host);
  session.attachBrowser(sender);
  session.attachBrowser(observer);
  const clientId = sender.messages()[0].clientId;
  const observerClientId = observer.messages()[0].clientId;
  const image = {
    type: "terminal-image-paste", requestId: "image_worker", surfaceId: "0000000000000001",
    leaseId: 4, mime: "image/png", data: "iVBORw0KGgo=",
  };
  sender.receive({ ...image, leaseId: null });
  assert.equal(host.sent.length, 0);
  sender.receive({ ...image, clientId: observerClientId });
  assert.deepEqual(host.messages().at(-1), { ...image, clientId });
  const beforeObserver = observer.sent.length;
  const result = { type: "terminal-image-paste-result", requestId: image.requestId, status: "denied" };
  host.receive({ ...result, clientId });
  assert.deepEqual(sender.messages().at(-1), result);
  assert.equal(observer.sent.length, beforeObserver);
});

test("Worker forwards workspace rename without a lease and broadcasts the authoritative title", () => {
  const session = workerSession(), host = new WorkerSocket(), browser = new WorkerSocket(), other = new WorkerSocket();
  session.attachWispTerm(host);
  session.attachBrowser(browser);
  session.attachBrowser(other);
  const clientId = browser.messages()[0].clientId;
  const rename = {
    type: "workspace-action", action: "rename-tab", requestId: "rename_1", title: "项目工作台",
    tabId: "0000000000000001", layoutRevision: "0000000000000002",
  };
  browser.receive({ ...rename, leaseId: 3 });
  browser.receive({ ...rename, title: "invalid\u0085line" });
  assert.equal(host.sent.length, 0);
  browser.receive({ ...rename, clientId: other.messages()[0].clientId });
  assert.deepEqual(host.messages().at(-1), { ...rename, clientId });

  const layout = { type: "layout", workspaceActions: true, tabRename: true, tabs: [
    { tabId: rename.tabId, layoutRevision: rename.layoutRevision, title: rename.title, surfaces: [] },
  ] };
  host.receive(layout);
  assert.deepEqual(browser.messages().at(-1), layout);
  assert.deepEqual(other.messages().at(-1), layout);
});

test("Worker removes failed browser from broadcasts, results, and input", () => {
  const session = workerSession(), host = new WorkerSocket(), browser = new WorkerSocket();
  session.attachWispTerm(host);
  session.attachBrowser(browser);
  const clientId = browser.messages()[0].clientId;
  browser.fail = true;
  host.receive({ type: "output", data: "broadcast" });
  browser.fail = false;
  const initial = browser.sent.length;
  host.receive({ type: "workspace-action-result", requestId: "r", clientId, status: "ok" });
  browser.receive({ type: "workspace-action", requestId: "r", action: "create-tab" });
  assert.equal(browser.sent.length, initial);
  assert.equal(host.sent.length, 0);
});
