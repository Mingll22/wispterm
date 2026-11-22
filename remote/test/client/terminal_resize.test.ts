import assert from "node:assert/strict";
import test from "node:test";
import xterm, { type Terminal } from "@xterm/xterm";
import { bindAlternateScreenResize } from "../../src/client/terminal_resize";

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

test("alternate screen drops cropped cells on split resize and retains shell history", async () => {
  const term = new xterm.Terminal({ cols: 24, rows: 6, scrollback: 50, allowProposedApi: true });
  bindAlternateScreenResize(term);
  try {
    await write(term, "shell history\r\n".repeat(8));
    await write(term, "\x1b[?1049h\x1b[2;10H界⣿⣤");
    term.resize(10, 6);

    const row = term.buffer.active.getLine(1)!;
    assert.equal(row.length, 10);
    assert.equal(row.getCell(9)?.getChars(), "");
    assert.equal(row.getCell(9)?.getWidth(), 1);

    term.resize(24, 6);
    assert.equal(term.buffer.active.getLine(1)?.translateToString(true), "");
    await write(term, "\x1b[?1049l");
    assert.equal(term.buffer.active.getLine(0)?.translateToString(true), "shell history");
    assert.ok(term.buffer.active.baseY > 0);
  } finally {
    term.dispose();
  }
});

test("alternate screen still has no scrollback when the pane was shortened before entry", async () => {
  const term = new xterm.Terminal({ cols: 24, rows: 12, allowProposedApi: true });
  bindAlternateScreenResize(term);
  try {
    term.resize(24, 5);
    await write(term, "\x1b[?1049h\x1b[5;1H" + "frame\r\n".repeat(10));
    assert.equal(term.buffer.active.length, 5);
    assert.equal(term.buffer.active.baseY, 0);
  } finally {
    term.dispose();
  }
});
