import test from "node:test";
import assert from "node:assert/strict";

import { RemoteSession } from "../../src/server/session";

class FakeSocket {
  readyState = 1;
  sent: string[] = [];
  listeners = new Map<string, Array<(raw?: unknown) => void>>();
  send(payload: string): void {
    this.sent.push(payload);
  }
  close(): void {}
  on(event: string, fn: (raw?: unknown) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
  }
  emit(event: string, raw?: unknown): void {
    if (event === "error" && !this.listeners.has(event)) {
      throw raw instanceof Error ? raw : new Error("Unhandled error event");
    }
    for (const fn of this.listeners.get(event) ?? []) fn(raw);
  }
}

class ThrowingSocket extends FakeSocket {
  send(_payload: string): void {
    throw new Error("send failed");
  }
}

test("RemoteSession finds ai chat and writable terminal surfaces from latest layout", () => {
  const session = new RemoteSession("alpha");
  session.applyLayout({
    type: "layout",
    activeTab: 0,
    tabs: [
      {
        index: 0,
        focusedSurfaceId: "term1",
        surfaces: [
          { id: "term1", title: "PowerShell", focused: true, kind: "terminal", readOnly: false },
          { id: "aichat0000000000", title: "AI", kind: "ai_chat", snapshot: "You\nhello\n\nAI\nhi" },
        ],
      },
    ],
  });

  assert.deepEqual(session.findAiChatSurface(), { id: "aichat0000000000", title: "AI" });
  assert.deepEqual(session.findDefaultWritableSurface(), { id: "term1", title: "PowerShell" });
  assert.equal(session.latestAiChatTranscript(), "You\nhello\n\nAI\nhi");
});

test("RemoteSession prefers writable terminal surfaces in the active tab", () => {
  const session = new RemoteSession("alpha");
  session.applyLayout({
    type: "layout",
    activeTab: 1,
    tabs: [
      {
        index: 0,
        focusedSurfaceId: "inactive-focused",
        surfaces: [
          {
            id: "inactive-focused",
            title: "Inactive Focused",
            focused: true,
            kind: "terminal",
            readOnly: false,
          },
        ],
      },
      {
        index: 1,
        focusedSurfaceId: "active-terminal",
        surfaces: [
          { id: "active-ai", title: "Active AI", focused: true, kind: "ai_chat", readOnly: false },
          { id: "active-terminal", title: "Active Terminal", kind: "terminal", readOnly: false },
        ],
      },
    ],
  });

  assert.deepEqual(session.findDefaultWritableSurface(), {
    id: "active-terminal",
    title: "Active Terminal",
  });
});

test("RemoteSession notifies layout listeners and supports unsubscribe", () => {
  const session = new RemoteSession("alpha");
  let calls = 0;
  const unsubscribe = session.onLayout(() => {
    calls += 1;
  });

  session.applyLayout({ type: "layout", activeTab: 0, tabs: [] });
  unsubscribe();
  session.applyLayout({ type: "layout", activeTab: 0, tabs: [] });

  assert.equal(calls, 1);
});

test("RemoteSession sends utf8 input bytes to connected WispTerm socket", () => {
  const session = new RemoteSession("alpha");
  const wispterm = new FakeSocket();
  session.attachWispTerm(wispterm as never);

  assert.equal(session.sendInput("surface1", "pwd\r"), true);
  assert.equal(wispterm.sent.length, 1);
  assert.deepEqual(JSON.parse(wispterm.sent[0]), {
    type: "input-bytes",
    surfaceId: "surface1",
    encoding: "hex",
    data: "7077640d",
  });
});

test("RemoteSession refuses input when WispTerm socket is disconnected", () => {
  const session = new RemoteSession("alpha");
  assert.equal(session.sendInput("surface1", "pwd\r"), false);
});

test("RemoteSession refuses input when WispTerm socket is not open or send fails", () => {
  const session = new RemoteSession("alpha");
  const closedWispTerm = new FakeSocket();
  closedWispTerm.readyState = 3;
  session.attachWispTerm(closedWispTerm as never);

  assert.equal(session.sendInput("surface1", "pwd\r"), false);

  const throwingWispTerm = new ThrowingSocket();
  session.attachWispTerm(throwingWispTerm as never);

  assert.equal(session.sendInput("surface1", "pwd\r"), false);
});

test("RemoteSession handles WispTerm socket errors without throwing", () => {
  const session = new RemoteSession("alpha");
  const wispterm = new FakeSocket();
  session.attachWispTerm(wispterm as never);

  assert.doesNotThrow(() => wispterm.emit("error", new Error("invalid websocket frame")));
});

test("RemoteSession handles browser socket errors without throwing", () => {
  const session = new RemoteSession("alpha");
  const browser = new FakeSocket();
  session.attachBrowser(browser as never);

  assert.doesNotThrow(() => browser.emit("error", new Error("invalid websocket frame")));
});

test("RemoteSession reports WispTerm peer status to browsers", () => {
  const session = new RemoteSession("alpha");
  const browser = new FakeSocket();
  session.attachBrowser(browser as never);

  assert.deepEqual(JSON.parse(browser.sent.at(-1) ?? "{}"), {
    type: "peer-status",
    wisptermConnected: false,
  });

  const wispterm = new FakeSocket();
  session.attachWispTerm(wispterm as never);

  assert.deepEqual(JSON.parse(browser.sent.at(-1) ?? "{}"), {
    type: "peer-status",
    wisptermConnected: true,
  });

  wispterm.emit("close");

  assert.deepEqual(JSON.parse(browser.sent.at(-1) ?? "{}"), {
    type: "peer-status",
    wisptermConnected: false,
  });
});

test("RemoteSession requests AI Agent open and resolves the matching result", async () => {
  const session = new RemoteSession("alpha");
  const wispterm = new FakeSocket();
  session.attachWispTerm(wispterm as never);

  const pending = session.requestAiAgentOpen("req-1", 50);
  assert.deepEqual(JSON.parse(wispterm.sent.at(-1) ?? "{}"), {
    type: "open-ai-agent",
    requestId: "req-1",
  });

  wispterm.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "open-ai-agent-result",
        requestId: "req-1",
        status: "opened",
      }),
    ),
  );

  assert.equal(await pending, "opened");
});

test("RemoteSession ignores AI Agent open results with unknown statuses", async () => {
  const session = new RemoteSession("alpha");
  const wispterm = new FakeSocket();
  session.attachWispTerm(wispterm as never);

  const pending = session.requestAiAgentOpen("req-invalid", 10);
  wispterm.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "open-ai-agent-result",
        requestId: "req-invalid",
        status: "bogus",
      }),
    ),
  );

  assert.equal(await pending, "timeout");
});

test("RemoteSession AI Agent open request times out without a matching result", async () => {
  const session = new RemoteSession("alpha");
  const wispterm = new FakeSocket();
  session.attachWispTerm(wispterm as never);

  assert.equal(await session.requestAiAgentOpen("req-timeout", 5), "timeout");
});

test("RemoteSession AI Agent open request reports offline when WispTerm is disconnected", async () => {
  const session = new RemoteSession("alpha");

  assert.equal(await session.requestAiAgentOpen("req-offline", 5), "offline");
});

test("RemoteSession AI Agent open request reports offline when send fails", async () => {
  const session = new RemoteSession("alpha");
  const wispterm = new ThrowingSocket();
  session.attachWispTerm(wispterm as never);

  assert.equal(await session.requestAiAgentOpen("req-send-fails", 50), "offline");
});

test("RemoteSession consumes AI Agent open results without broadcasting them to browsers", () => {
  const session = new RemoteSession("alpha");
  const browser = new FakeSocket();
  const wispterm = new FakeSocket();
  session.attachBrowser(browser as never);
  session.attachWispTerm(wispterm as never);
  const sentBefore = browser.sent.length;

  wispterm.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "open-ai-agent-result",
        requestId: "req-unmatched",
        status: "opened",
      }),
    ),
  );

  assert.equal(browser.sent.length, sentBefore);
});

test("RemoteSession resolves pending AI Agent open requests offline when WispTerm closes", async () => {
  const session = new RemoteSession("alpha");
  const wispterm = new FakeSocket();
  session.attachWispTerm(wispterm as never);

  const pending = session.requestAiAgentOpen("req-close", 50);
  wispterm.emit("close");

  assert.equal(await pending, "offline");
});

test("RemoteSession resolves pending AI Agent open requests offline when WispTerm errors", async () => {
  const session = new RemoteSession("alpha");
  const wispterm = new FakeSocket();
  session.attachWispTerm(wispterm as never);

  const pending = session.requestAiAgentOpen("req-error", 50);
  wispterm.emit("error", new Error("socket failed"));

  assert.equal(await pending, "offline");
});

test("RemoteSession resolves pending AI Agent open requests offline when WispTerm is replaced", async () => {
  const session = new RemoteSession("alpha");
  const firstWispTerm = new FakeSocket();
  const nextWispTerm = new FakeSocket();
  session.attachWispTerm(firstWispTerm as never);

  const pending = session.requestAiAgentOpen("req-replaced", 50);
  session.attachWispTerm(nextWispTerm as never);

  assert.equal(await pending, "offline");
});

function receive(socket: FakeSocket, message: unknown): void {
  socket.emit("message", Buffer.from(JSON.stringify(message)));
}

function messages(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map((message) => JSON.parse(message));
}

test("a late browser gets the snapshot layout before subsequent grid changes", () => {
  const session = new RemoteSession("alpha");
  const host = new FakeSocket();
  const first = new FakeSocket();
  const second = new FakeSocket();
  session.attachWispTerm(host as never);
  const layout = { type: "layout", tabs: [{ index: 0, surfaces: [{ id: "s", cols: 80, rows: 24, snapshot: "old" }] }] };
  receive(host, layout);
  receive(host, { type: "terminal-grid", surfaceId: "s", cols: 44, rows: 70 });
  const currentGrid = { type: "terminal-grid", surfaceId: "s", cols: 42, rows: 71 };
  receive(host, currentGrid);
  session.attachBrowser(first as never);
  assert.deepEqual(messages(first).filter((m) => m.type === "layout" || m.type === "terminal-grid"), [layout, currentGrid]);
  const freshLayout = { type: "layout", tabs: [{ index: 0, surfaces: [{ id: "s", cols: 42, rows: 71, snapshot: "new" }] }] };
  receive(host, freshLayout);
  session.attachBrowser(second as never);
  assert.deepEqual(messages(second).filter((m) => m.type === "layout" || m.type === "terminal-grid"), [freshLayout]);
});

test("browser connections receive distinct relay identities before layouts and cannot forge them", () => {
  const session = new RemoteSession("alpha");
  const host = new FakeSocket();
  const first = new FakeSocket();
  const second = new FakeSocket();
  session.attachWispTerm(host as never);
  receive(host, { type: "layout", tabs: [] });
  session.attachBrowser(first as never);
  session.attachBrowser(second as never);
  const id1 = messages(first)[0];
  const id2 = messages(second)[0];
  assert.equal(id1.type, "terminal-control-client");
  assert.match(id1.clientId as string, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(id1.clientId, id2.clientId);
  assert.ok(messages(first).findIndex((m) => m.type === "layout") > 0);
  receive(first, { type: "terminal-control", surfaceId: "s", action: "acquire", cols: 80, rows: 24, clientId: id2.clientId });
  receive(second, { type: "input-bytes", surfaceId: "s", data: "61", encoding: "hex", clientId: id1.clientId, leaseId: 12 });
  receive(first, { type: "input-bytes", surfaceId: "ai", data: "61", encoding: "hex" });
  assert.deepEqual(messages(host), [
    { type: "terminal-control", surfaceId: "s", action: "acquire", clientId: id1.clientId, cols: 80, rows: 24 },
    { type: "input-bytes", surfaceId: "s", data: "61", encoding: "hex", clientId: id2.clientId, leaseId: 12 },
    { type: "input-bytes", surfaceId: "ai", data: "61", encoding: "hex", clientId: id1.clientId },
  ]);
});

test("terminal control validates action, grid and lease before forwarding", () => {
  const session = new RemoteSession("alpha");
  const host = new FakeSocket();
  const browser = new FakeSocket();
  session.attachWispTerm(host as never);
  session.attachBrowser(browser as never);
  const base = { type: "terminal-control", surfaceId: "s" };
  for (const fields of [
    { action: "acquire", cols: 1, rows: 24 }, { action: "takeover", cols: 513, rows: 24 },
    { action: "acquire", cols: 80, rows: 0 }, { action: "acquire", cols: 80, rows: 257 },
    { action: "acquire", cols: 80.5, rows: 24 }, { action: "renew" },
    { action: "release", leaseId: 0 }, { action: "resize", leaseId: 0x100000000, cols: 80, rows: 24 },
    { action: "resize", leaseId: 1, cols: 80 }, { action: "other" },
  ]) receive(browser, { ...base, ...fields });
  receive(browser, { type: "input-bytes", surfaceId: "s", data: "61", leaseId: -1 });
  receive(browser, { ...base, action: "renew", leaseId: 0xffffffff });
  receive(browser, { ...base, action: "resize", leaseId: 1, cols: 512, rows: 256 });
  receive(browser, { ...base, action: "release", leaseId: 1 });
  assert.deepEqual(messages(host).map(({ action }) => action), ["renew", "resize", "release"]);
});

test("only current host broadcasts validated ordered terminal events to its own session", () => {
  const alpha = new RemoteSession("alpha");
  const beta = new RemoteSession("beta");
  const oldHost = new FakeSocket();
  const host = new FakeSocket();
  const browser = new FakeSocket();
  const otherBrowser = new FakeSocket();
  alpha.attachWispTerm(oldHost as never);
  alpha.attachBrowser(browser as never);
  beta.attachBrowser(otherBrowser as never);
  alpha.attachWispTerm(host as never);
  const initial = browser.sent.length;
  const otherInitial = otherBrowser.sent.length;
  receive(oldHost, { type: "terminal-grid", surfaceId: "s", cols: 80, rows: 24 });
  receive(browser, { type: "terminal-control-state", surfaceId: "s", clientId: null, leaseId: null, reason: "released" });
  receive(host, { type: "terminal-control-state", surfaceId: "s", clientId: "abc", leaseId: 1, reason: "invalid" });
  receive(host, { type: "terminal-grid", surfaceId: "s", cols: -1, rows: 24 });
  receive(host, { type: "terminal-control-state", surfaceId: "s", clientId: "abc", leaseId: 1, reason: "acquired", ignored: true });
  receive(host, { type: "terminal-grid", surfaceId: "s", cols: 600, rows: 300 });
  assert.deepEqual(messages(browser).slice(initial), [
    { type: "terminal-control-state", surfaceId: "s", clientId: "abc", leaseId: 1, reason: "acquired" },
    { type: "terminal-grid", surfaceId: "s", cols: 600, rows: 300 },
  ]);
  assert.equal(otherBrowser.sent.length, otherInitial);
});

test("workspace action identities cannot be forged and replies are private", () => {
  const session = new RemoteSession("alpha");
  const host = new FakeSocket(), first = new FakeSocket(), second = new FakeSocket();
  session.attachWispTerm(host as never);
  session.attachBrowser(first as never);
  session.attachBrowser(second as never);
  const firstId = messages(first)[0].clientId, secondId = messages(second)[0].clientId;
  const firstCount = first.sent.length, secondCount = second.sent.length;
  receive(first, { type: "workspace-action", requestId: "req_1", action: "close-pane", clientId: secondId, tabId: "0123456789abcdef", layoutRevision: "000000000000000a", surfaceId: "fedcba9876543210", ignored: true });
  assert.deepEqual(messages(host).at(-1), { type: "workspace-action", requestId: "req_1", action: "close-pane", clientId: firstId, tabId: "0123456789abcdef", layoutRevision: "000000000000000a", surfaceId: "fedcba9876543210" });
  receive(host, { type: "workspace-action-result", requestId: "req_1", clientId: firstId, status: "stale", tabId: "0123456789abcdef", ignored: true });
  assert.deepEqual(messages(first).slice(firstCount), [{ type: "workspace-action-result", requestId: "req_1", status: "stale", tabId: "0123456789abcdef" }]);
  assert.equal(second.sent.length, secondCount);
  receive(host, { type: "workspace-action-result", requestId: "req_1", clientId: firstId, status: "offline" });
  receive(host, { type: "workspace-action-result", requestId: "req_1", clientId: firstId, status: "ok", tabId: "BAD" });
  receive(second, { type: "workspace-action-result", requestId: "req_1", clientId: firstId, status: "ok" });
  assert.equal(first.sent.length, firstCount + 1);
});

test("workspace wire validation rejects invalid shapes but leaves revisions to the host", () => {
  const session = new RemoteSession("alpha"), host = new FakeSocket(), browser = new FakeSocket();
  session.attachWispTerm(host as never);
  session.attachBrowser(browser as never);
  const base = { type: "workspace-action", requestId: "r", action: "set-layout", tabId: "0123456789abcdef", layoutRevision: "0000000000000000" };
  const leaf = { surfaceId: "fedcba9876543210" };
  for (const message of [
    { ...base, requestId: "bad id", splitTree: [leaf] },
    { ...base, requestId: "bad\n", splitTree: [leaf] },
    { ...base, requestId: "a".repeat(65), splitTree: [leaf] },
    { ...base, tabId: "0123456789abcdeF", splitTree: [leaf] },
    { ...base, layoutRevision: "1", splitTree: [leaf] },
    { ...base, splitTree: [] }, { ...base, splitTree: [leaf, leaf] },
    { ...base, splitTree: [{ axis: "x", ratio: 0.5 }, leaf] },
    { ...base, splitTree: [{ axis: "x", ratio: 0 }, leaf, leaf] },
    { ...base, splitTree: [{ axis: "y", ratio: 1 }, leaf, leaf] },
    { ...base, splitTree: [{ axis: "z", ratio: 0.5 }, leaf, leaf] },
    { ...base, splitTree: [{ ...leaf, axis: "x", ratio: 0.5 }] },
    { ...base, splitTree: Array.from({ length: 129 }, () => leaf) },
    { ...base, action: "add-pane" }, { ...base, action: "create-tab" },
    { ...base, action: "close-tab", surfaceId: leaf.surfaceId },
  ]) receive(browser, message);
  assert.equal(host.sent.length, 0);
  receive(browser, { ...base, splitTree: [{ axis: "x", ratio: 0.5 }, leaf, { surfaceId: "1111111111111111" }] });
  assert.equal(messages(host).length, 1);
  assert.equal(messages(host)[0].layoutRevision, "0000000000000000");
});

test("workspace action reports offline for absent or failed host", () => {
  for (const failed of [false, true]) {
    const session = new RemoteSession("alpha"), browser = new FakeSocket();
    session.attachBrowser(browser as never);
    if (failed) session.attachWispTerm(new ThrowingSocket() as never);
    receive(browser, { type: "workspace-action", requestId: "r", action: "create-tab" });
    assert.deepEqual(messages(browser).at(-1), { type: "workspace-action-result", requestId: "r", status: "offline" });
  }
});

test("failed browser broadcast removes the client from every relay path", () => {
  class FailingBrowser extends FakeSocket {
    fail = false;
    override send(payload: string): void {
      if (this.fail) throw new Error("send failed");
      super.send(payload);
    }
  }
  const session = new RemoteSession("alpha"), host = new FakeSocket(), browser = new FailingBrowser();
  session.attachWispTerm(host as never);
  session.attachBrowser(browser as never);
  const clientId = messages(browser)[0].clientId;
  browser.fail = true;
  receive(host, { type: "output", data: "broadcast" });
  browser.fail = false;
  const initial = browser.sent.length;
  receive(host, { type: "workspace-action-result", requestId: "r", clientId, status: "ok" });
  receive(browser, { type: "workspace-action", requestId: "r", action: "create-tab" });
  assert.equal(browser.sent.length, initial);
  assert.equal(host.sent.length, 0);
});
