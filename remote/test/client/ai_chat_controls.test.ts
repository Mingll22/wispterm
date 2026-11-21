import test from "node:test";
import assert from "node:assert/strict";

import { aiChatStopControlState } from "../../src/client/ai_chat_controls";

test("AI chat stop control is enabled only while connected and running", () => {
  assert.deepEqual(aiChatStopControlState({ id: "ai", kind: "ai_chat", requestInflight: true }, true), {
    disabled: false,
    label: "停止",
  });
  assert.deepEqual(aiChatStopControlState({ id: "ai", kind: "ai_chat", requestInflight: true }, false), {
    disabled: true,
    label: "停止",
  });
  assert.deepEqual(aiChatStopControlState({ id: "ai", kind: "ai_chat", requestInflight: false }, true), {
    disabled: true,
    label: "停止",
  });
});

test("AI chat stop control stays available for older desktop layouts without runtime state", () => {
  assert.deepEqual(aiChatStopControlState({ id: "ai", kind: "ai_chat" }, true), {
    disabled: false,
    label: "停止",
  });
});

test("AI chat stop control shows stopping state after stop request", () => {
  assert.deepEqual(
    aiChatStopControlState({ id: "ai", kind: "ai_chat", requestInflight: true, requestStopping: true }, true),
    {
      disabled: true,
      label: "正在停止…",
    },
  );
});
