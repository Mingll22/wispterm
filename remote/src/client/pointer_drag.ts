export function watchPointer(
  handle: HTMLElement,
  start: PointerEvent,
  move: (event: PointerEvent) => void,
  finish: (committed: boolean) => void,
): () => void {
  const pointerId = start.pointerId;
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  function end(committed: boolean): void {
    listeners.abort();
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    finish(committed);
  }
  handle.setPointerCapture(pointerId);
  handle.addEventListener("pointermove", (event) => { if (event.pointerId === pointerId) move(event); }, options);
  handle.addEventListener("pointerup", (event) => { if (event.pointerId === pointerId) end(true); }, options);
  handle.addEventListener("lostpointercapture", (event) => { if (event.pointerId === pointerId) end(false); }, options);
  handle.addEventListener("pointercancel", (event) => { if (event.pointerId === pointerId) end(false); }, options);
  return () => end(false);
}
