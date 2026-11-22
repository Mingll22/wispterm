import assert from "node:assert/strict";
import test from "node:test";
import type { TabControlRequest, TabControlState } from "../../src/tab_control_protocol";
import { normalizeLayout } from "../../src/client/layout";
import { activeSurfaceIdForInput, inputLeaseId, state } from "../../src/client/state";
import { setTabControlSender, tabControl, TabControl } from "../../src/client/tab_control";

const tabId = "0000000000000001";
const left = { surfaceId: "0000000000000002", grid: { cols: 80, rows: 40 } };
const right = { surfaceId: "0000000000000003", grid: { cols: 100, rows: 40 } };
const members = [left.surfaceId, right.surfaceId];

function harness() {
  const sent: TabControlRequest[] = [];
  const control = new TabControl((request) => {
    sent.push(request);
    return true;
  });
  control.connect("tablet");
  control.setDesktopReady(true);
  const receive = (clientId: string | null, leaseId: number | null, reason: TabControlState["reason"], foreground = true) =>
    control.receive({ type: "tab-control-state", tabId, clientId, leaseId, reason }, foreground);
  return { control, receive, sent };
}

test("one lease covers the whole tab, including panes hidden in single-pane mode", () => {
  const { control, receive, sent } = harness();
  control.reconcile(tabId, members, [left], true);
  receive("tablet", 7, "acquired");
  assert.equal(control.leaseId(tabId), 7);
  assert.equal(control.leaseId("unrelated"), undefined);

  control.reconcile(tabId, members, [right], true);
  assert.equal(control.leaseId(tabId), 7);
  control.reconcile(tabId, members, [left, right], true);
  control.renew();
  assert.deepEqual(sent, [
    { type: "tab-control", action: "acquire", tabId },
    { type: "tab-control", action: "resize", tabId, leaseId: 7, grids: [{ surfaceId: left.surfaceId, ...left.grid }] },
    { type: "tab-control", action: "resize", tabId, leaseId: 7, grids: [{ surfaceId: right.surfaceId, ...right.grid }] },
    { type: "tab-control", action: "renew", tabId, leaseId: 7 },
  ]);
});

test("mirror layout batches visible grids and sends only changed dimensions", () => {
  const { control, receive, sent } = harness();
  control.reconcile(tabId, members, [left, right], true);
  receive("tablet", 7, "acquired");
  control.reconcile(tabId, members, [left, right], true);
  const widerLeft = { ...left, grid: { ...left.grid, cols: 84 } };
  control.reconcile(tabId, members, [widerLeft, right], true);
  assert.deepEqual(sent.slice(1), [
    { type: "tab-control", action: "resize", tabId, leaseId: 7, grids: [
      { surfaceId: left.surfaceId, ...left.grid }, { surfaceId: right.surfaceId, ...right.grid },
    ] },
    { type: "tab-control", action: "resize", tabId, leaseId: 7, grids: [{ surfaceId: widerLeft.surfaceId, ...widerLeft.grid }] },
  ]);
});

test("contention, desktop interruption and manual return require an explicit takeover", () => {
  const { control, receive, sent } = harness();
  control.reconcile(tabId, members, [left], true);
  receive("phone", 4, "denied");
  control.reconcile(tabId, members, [right], true);
  control.renew();
  assert.equal(sent.length, 1);

  control.takeOver(tabId);
  receive("tablet", 7, "taken");
  receive(null, null, "denied");
  assert.equal(control.leaseId(tabId), 7);
  receive(null, null, "desktop");
  assert.equal(control.leaseId(tabId), undefined);
  control.reconcile(tabId, members, [right], true);
  assert.deepEqual(sent.map(({ action }) => action), ["acquire", "takeover", "resize"]);

  control.takeOver(tabId);
  receive("tablet", 8, "taken");
  control.release(tabId);
  control.reconcile(tabId, members, [left, right], true);
  assert.deepEqual(sent.map(({ action }) => action), ["acquire", "takeover", "resize", "takeover", "resize", "release"]);
});

test("when selection changes, a late grant is immediately returned", () => {
  const { control, receive, sent } = harness();
  control.reconcile(tabId, members, [left], true);
  const nextTab = "0000000000000004";
  control.reconcile(nextTab, members, [right], true);
  receive("tablet", 7, "acquired");
  assert.equal(control.leaseId(tabId), undefined);
  assert.deepEqual(sent.at(-1), { type: "tab-control", action: "release", tabId, leaseId: 7 });
});

test("layout members use the tab lease without a legacy per-pane flag", () => {
  const layout = (ids: string[]) => normalizeLayout({
    type: "layout",
    activeTab: 0,
    workspaceActions: true,
    tabControl: true,
    tabs: [{
      index: 0, tabId, layoutRevision: "0000000000000001",
      splitTree: [...(ids.length === 2 ? [{ axis: "x", ratio: 0.5 }] : []), ...ids.map((surfaceId) => ({ surfaceId }))],
      surfaces: ids.map((id) => ({ id })),
    }],
  });
  const previous = state.layoutState;
  state.layoutState = layout([left.surfaceId]);
  setTabControlSender(() => true);
  tabControl.connect("tablet");
  tabControl.setDesktopReady(true);
  try {
    assert.equal(activeSurfaceIdForInput(), null);
    tabControl.reconcile(tabId, [left.surfaceId], [left], true);
    tabControl.receive({ type: "tab-control-state", tabId, clientId: "tablet", leaseId: 7, reason: "acquired" }, true);

    // Adding a pane updates the layout before the next grid measurement.
    state.layoutState = layout(members);
    assert.equal(activeSurfaceIdForInput(), left.surfaceId);
    assert.equal(inputLeaseId(right.surfaceId), 7);
    assert.equal(inputLeaseId("unrelated"), undefined);
  } finally {
    tabControl.connect(null);
    tabControl.setDesktopReady(false);
    setTabControlSender(() => false);
    state.layoutState = previous;
  }
});
