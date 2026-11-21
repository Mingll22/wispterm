import assert from "node:assert/strict";
import test from "node:test";
import { TerminalControl, type TerminalControlRequest } from "../../src/client/terminal_control";

function controller() {
  const sent: TerminalControlRequest[] = [];
  const control = new TerminalControl((request) => {
    sent.push(request);
    return true;
  });
  control.connect("tablet");
  control.setDesktopReady(true);
  return { control, sent };
}

const panel = { surfaceId: "left", grid: { cols: 96, rows: 36 } };

test("initial acquisition measures each visible pane and renewals contain no size", () => {
  const { control, sent } = controller();
  const other = { surfaceId: "right", grid: { cols: 48, rows: 36 } };
  control.reconcile([panel, other], true);
  control.receive("left", "tablet", 3, "acquired", true);
  control.receive("right", "phone", 4, "denied", true);
  assert.equal(control.controlledByOther("left"), false);
  assert.equal(control.controlledByOther("right"), true);
  control.renew();
  control.reconcile([panel, other], true);
  control.reconcile([{ ...panel, grid: { cols: 97, rows: 36 } }, other], true);
  assert.deepEqual(sent, [
    { type: "terminal-control", action: "acquire", surfaceId: "left", cols: 96, rows: 36 },
    { type: "terminal-control", action: "acquire", surfaceId: "right", cols: 48, rows: 36 },
    { type: "terminal-control", action: "renew", surfaceId: "left", leaseId: 3 },
    { type: "terminal-control", action: "resize", surfaceId: "left", leaseId: 3, cols: 97, rows: 36 },
  ]);
});

test("desktop revocation never auto-reacquires on resize; takeover is explicit", () => {
  const { control, sent } = controller();
  control.reconcile([panel], true);
  control.receive("left", "tablet", 3, "acquired", true);
  control.receive("left", null, null, "desktop", true);
  control.reconcile([{ ...panel, grid: { cols: 97, rows: 36 } }], true);
  control.renew();
  assert.equal(control.leaseId("left"), undefined);
  assert.equal(control.reason("left"), "desktop");
  assert.equal(sent.length, 1);
  control.takeOver("left");
  assert.deepEqual(sent[1], { type: "terminal-control", action: "takeover", surfaceId: "left", cols: 97, rows: 36 });
});

test("an acquisition granted after leaving the pane is returned to the desktop", () => {
  const { control, sent } = controller();
  control.reconcile([panel], true);
  control.reconcile([], true);
  control.receive("left", "tablet", 3, "acquired", true);
  assert.deepEqual(sent[1], { type: "terminal-control", action: "release", surfaceId: "left", leaseId: 3 });
});

test("hiding the page pauses geometry requests; changing visible panels releases the held lease", () => {
  const { control, sent } = controller();
  control.reconcile([panel], false);
  assert.equal(sent.length, 0);
  control.reconcile([panel], true);
  control.receive("left", "tablet", 3, "acquired", true);
  control.reconcile([{ ...panel, grid: { cols: 97, rows: 36 } }], false);
  assert.equal(sent.length, 1);
  control.reconcile([], true);
  assert.deepEqual(sent[1], { type: "terminal-control", action: "release", surfaceId: "left", leaseId: 3 });
});

test("a foreground return can acquire an expired own lease without taking over another viewer", () => {
  const { control, sent } = controller();
  control.reconcile([panel], true);
  control.receive("left", "tablet", 3, "acquired", true);
  control.receive("left", null, null, "expired", false);
  control.reconcile([panel], false);
  assert.equal(sent.length, 1);
  control.reconcile([panel], true);
  assert.deepEqual(sent[1], { type: "terminal-control", action: "acquire", surfaceId: "left", cols: 96, rows: 36 });
  control.receive("left", "phone", 4, "denied", true);
  control.receive("left", null, null, "expired", true);
  control.reconcile([panel], true);
  assert.equal(sent.length, 2);
});
