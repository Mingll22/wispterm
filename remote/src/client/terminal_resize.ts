import type { Terminal } from "@xterm/xterm";

type BufferLine = {
  length: number;
  getWidth(column: number): number;
  setCell(column: number, cell: unknown): void;
  resize(cols: number, fill: unknown): boolean;
};

type AlternateBuffer = {
  lines: {
    length: number;
    maxLength: number;
    get(index: number): BufferLine;
  };
  getNullCell(): unknown;
};

export function bindAlternateScreenResize(term: Terminal): void {
  // In xterm 6.0 only buffers with reflow enabled discard clipped cells.
  // The alternate screen keeps them, so they can appear in later frames.
  // https://github.com/xtermjs/xterm.js/issues/6228
  const core = (term as unknown as {
    _core: { _bufferService: { buffers: { alt: AlternateBuffer } } };
  })._core;
  term.onResize(({ cols, rows }) => {
    const alt = core._bufferService.buffers.alt;
    if (alt.lines.length === 0) {
      // A shrink before entering the alternate screen also needs to reduce
      // its capacity, so scrolling at the bottom cannot create scrollback.
      // https://github.com/xtermjs/xterm.js/issues/6163
      alt.lines.maxLength = rows;
      return;
    }
    const blank = alt.getNullCell();
    for (let index = 0; index < alt.lines.length; index++) {
      const line = alt.lines.get(index);
      if (line.length <= cols) continue;
      if (line.getWidth(cols - 1) === 2) line.setCell(cols - 1, blank);
      line.resize(cols, blank);
    }
  });
}
