import test from "node:test";
import assert from "node:assert/strict";
import { isRemoteLocale, resolveLocale } from "../../src/client/i18n";

test("the saved language wins over the browser language", () => {
  assert.equal(resolveLocale("en", "zh-CN"), "en");
  assert.equal(resolveLocale("zh-CN", "en-US"), "zh-CN");
});

test("Chinese browsers get Simplified Chinese and other browsers fall back to English", () => {
  assert.equal(resolveLocale(null, "zh-TW"), "zh-CN");
  assert.equal(resolveLocale("unknown", "de-DE"), "en");
  assert.equal(resolveLocale(null), "en");
  assert.equal(isRemoteLocale("en-US"), false);
});
