import test from "node:test";
import assert from "node:assert/strict";

import {
  mobileVisualZoomLabel,
  MOBILE_VISUAL_ZOOM_LEVELS,
  normalizeMobileVisualZoom,
  scaleVisualCanvasSize,
} from "../../src/client/mobile_visual_zoom";

test("stored numeric strings restore every selectable mobile zoom level", () => {
  for (const zoom of MOBILE_VISUAL_ZOOM_LEVELS) {
    assert.equal(normalizeMobileVisualZoom(String(zoom)), zoom);
  }
});

test("mobile visual zoom renders compact percent labels", () => {
  assert.equal(mobileVisualZoomLabel(1), "100%");
  assert.equal(mobileVisualZoomLabel(0.75), "75%");
  assert.equal(mobileVisualZoomLabel(0.5), "50%");
  assert.equal(mobileVisualZoomLabel(0.25), "25%");
});

test("mobile visual zoom accepts saved decimal and percent values", () => {
  assert.equal(normalizeMobileVisualZoom("1"), 1);
  assert.equal(normalizeMobileVisualZoom("0.75"), 0.75);
  assert.equal(normalizeMobileVisualZoom("50%"), 0.5);
  assert.equal(normalizeMobileVisualZoom("25"), 0.25);
});

test("mobile visual zoom falls back to full size for unknown values", () => {
  assert.equal(normalizeMobileVisualZoom("0.9"), 1);
  assert.equal(normalizeMobileVisualZoom("wide"), 1);
  assert.equal(normalizeMobileVisualZoom(null), 1);
});

test("mobile visual zoom scales canvas dimensions used for pan bounds", () => {
  assert.deepEqual(scaleVisualCanvasSize({ width: 900, height: 600 }, 0.5), {
    width: 450,
    height: 300,
  });
  assert.deepEqual(scaleVisualCanvasSize({ width: 901, height: 601 }, 0.25), {
    width: 225,
    height: 150,
  });
});
