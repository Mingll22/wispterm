import { REMOTE_TERMINAL_FONT_SIZE } from "./terminal_options";

const MIN_DESKTOP_FONT_SIZE = 12;
const MAX_DESKTOP_FONT_SIZE = 24;

type Size = { width: number; height: number };
type GridViewport = Size & { cols: number; rows: number };

export function desktopTerminalFontSize(
  viewports: GridViewport[],
  measureCell: (fontSize: number) => Size | undefined,
): number {
  if (!viewports.length) return REMOTE_TERMINAL_FONT_SIZE;

  // Leave a CSS pixel for xterm's rounding of the complete grid dimensions.
  const maxCellWidth = Math.min(...viewports.map((view) => (view.width - 1) / view.cols));
  const maxCellHeight = Math.min(...viewports.map((view) => (view.height - 1) / view.rows));
  let low = MIN_DESKTOP_FONT_SIZE;
  let high = MAX_DESKTOP_FONT_SIZE;

  while (low < high) {
    const size = Math.ceil((low + high) / 2);
    const cell = measureCell(size);
    if (!cell) return REMOTE_TERMINAL_FONT_SIZE;
    if (cell.width <= maxCellWidth && cell.height <= maxCellHeight) {
      low = size;
    } else {
      high = size - 1;
    }
  }
  return low;
}
