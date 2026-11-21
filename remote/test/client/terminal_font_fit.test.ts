import test from "node:test";
import assert from "node:assert/strict";

import { desktopTerminalFontSize } from "../../src/client/terminal_font_fit";
import { REMOTE_TERMINAL_FONT_SIZE } from "../../src/client/terminal_options";

const measureCell = (fontSize: number) => ({ width: fontSize / 2, height: fontSize });

test("the tighter pane limits the common font and single-panel mode uses the available space", () => {
  const first = { width: 601, height: 900, cols: 100, rows: 35 };
  const second = { width: 801, height: 801, cols: 80, rows: 40 };
  assert.equal(desktopTerminalFontSize([first, second], measureCell), 12);
  assert.equal(desktopTerminalFontSize([second], measureCell), 20);
});

test("keeps text readable when a grid requires panning and caps enlargement in a large window", () => {
  const grid = { cols: 100, rows: 60 };
  assert.equal(desktopTerminalFontSize([{ ...grid, width: 300, height: 300 }], measureCell), 12);
  assert.equal(desktopTerminalFontSize([{ ...grid, width: 2000, height: 2000 }], measureCell), 24);
});

test("uses the default font when no remote grid or renderer measurement is available", () => {
  assert.equal(desktopTerminalFontSize([], measureCell), REMOTE_TERMINAL_FONT_SIZE);
  assert.equal(
    desktopTerminalFontSize([{ width: 1000, height: 1000, cols: 100, rows: 60 }], () => undefined),
    REMOTE_TERMINAL_FONT_SIZE,
  );
});
