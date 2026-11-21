import test from "node:test";
import assert from "node:assert/strict";

import { WEB_VERSION, remoteBrandMarkup, webVersionLabel } from "../../src/client/version";

test("web version is exposed for the remote UI", () => {
  assert.equal(WEB_VERSION, "v0.32.0");
  assert.equal(webVersionLabel(), "网页版 v0.32.0");
});

test("web version label always includes the release version", () => {
  assert.equal(webVersionLabel("build fixture"), "网页版 v0.32.0 (build fixture)");
});

test("remote brand markup exposes the web version for shell views", () => {
  assert.equal(remoteBrandMarkup(), 'WispTerm Remote <span class="web-version">网页版 v0.32.0</span>');
});
