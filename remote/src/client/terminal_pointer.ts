import type { Terminal } from "@xterm/xterm";

type PointerPosition = Pick<MouseEvent, "clientX" | "clientY">;

type XtermCore = {
  screenElement: HTMLElement;
  _mouseService: {
    getCoords(
      event: PointerPosition, element: HTMLElement, cols: number, rows: number, selection?: boolean,
    ): [number, number] | undefined;
    getMouseReportCoords(
      event: PointerPosition, element: HTMLElement,
    ): { col: number; row: number; x: number; y: number } | undefined;
  };
  _selectionService: {
    _getMouseEventScrollAmount(event: PointerPosition): number;
  };
};

export function mapScaledTerminalPointer(terminal: Terminal, isFitted: () => boolean): void {
  // xterm 6 compares viewport pointer positions with unscaled cell dimensions.
  const { screenElement, _mouseService: mouse, _selectionService: selection } =
    (terminal as unknown as { _core: XtermCore })._core;
  const getCoords = mouse.getCoords.bind(mouse);
  const getMouseReportCoords = mouse.getMouseReportCoords.bind(mouse);
  const getSelectionScroll = selection._getMouseEventScrollAmount.bind(selection);
  const relative = (event: PointerPosition, element: HTMLElement): PointerPosition => {
    if (!isFitted()) return event;
    const width = element.offsetWidth;
    const bounds = element.getBoundingClientRect();
    if (!width || !bounds.width || bounds.width === width) return event;
    const inverseScale = width / bounds.width;
    return {
      clientX: bounds.left + (event.clientX - bounds.left) * inverseScale,
      clientY: bounds.top + (event.clientY - bounds.top) * inverseScale,
    };
  };
  mouse.getCoords = (event, element, ...args) => getCoords(relative(event, element), element, ...args);
  mouse.getMouseReportCoords = (event, element) => getMouseReportCoords(relative(event, element), element);
  selection._getMouseEventScrollAmount = (event) => getSelectionScroll(relative(event, screenElement));
}
