import test from "node:test";
import assert from "node:assert/strict";

import {
  HIGH_LATENCY_THRESHOLD_MS,
  connectionStatusForLatency,
  connectionStatusWithoutPeer,
  latencyDisclosureText,
} from "../../src/client/connection_status";

test("connection status uses red when WispTerm peer is not connected", () => {
  assert.deepEqual(connectionStatusWithoutPeer(null), {
    kind: "offline",
    text: "桌面端未连接",
    latencyMs: null,
    detail: "暂无延迟数据",
  });
  assert.deepEqual(connectionStatusWithoutPeer(42), {
    kind: "offline",
    text: "桌面端未连接 · 中继延迟 42 ms",
    latencyMs: 42,
    detail: "中继延迟 42 ms",
  });
});

test("connection status maps 500ms threshold to low and high latency", () => {
  assert.equal(HIGH_LATENCY_THRESHOLD_MS, 500);
  assert.deepEqual(connectionStatusForLatency(499), {
    kind: "online",
    text: "低延迟 · 499 ms",
    latencyMs: 499,
    detail: "延迟 499 ms",
  });
  assert.deepEqual(connectionStatusForLatency(500), {
    kind: "online",
    text: "低延迟 · 500 ms",
    latencyMs: 500,
    detail: "延迟 500 ms",
  });
  assert.deepEqual(connectionStatusForLatency(501), {
    kind: "high-latency",
    text: "高延迟 · 501 ms",
    latencyMs: 501,
    detail: "延迟 501 ms",
  });
});

test("latency disclosure rounds measurements for click feedback", () => {
  assert.equal(latencyDisclosureText(null), "暂无延迟数据");
  assert.equal(latencyDisclosureText(123.6), "延迟 124 ms");
});
