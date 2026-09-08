import { useCallback, useEffect, useRef, type PointerEvent, type RefObject } from "react";
import { setDragging } from "@/stores/splitDragState";

export interface PanelResizeOptions {
  element: RefObject<HTMLElement | null>;
  width: number;
  min: number;
  max: number;
  direction?: 1 | -1;
  onCommit: (width: number) => void;
  onCollapse?: () => void;
}

/** Preview on the DOM; persist once. Cancellation never changes the saved width. */
export function usePanelResize(options: PanelResizeOptions) {
  const current = useRef(options);
  current.current = options;
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  return useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); cleanup.current?.();
    const config = current.current;
    const target = config.element.current;
    if (!target) return;
    const start = event.clientX, original = config.width;
    const previousCursor = document.body.style.cursor, previousSelection = document.body.style.userSelect;
    let raw = original, next = original, frame = 0;
    const preview = () => { target.style.width = `${next}px`; };
    const move = (e: globalThis.PointerEvent) => {
      raw = original + (e.clientX - start) * (config.direction ?? 1);
      next = Math.round(Math.min(Math.min(config.max, window.innerWidth - 16), Math.max(config.min, raw)));
      cancelAnimationFrame(frame); frame = requestAnimationFrame(preview);
    };
    const finish = (cancelled: boolean) => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      document.body.style.cursor = previousCursor; document.body.style.userSelect = previousSelection;
      cleanup.current = null;
      setDragging(false);
      if (cancelled) { target.style.width = `${original}px`; return; }
      if (config.onCollapse && raw < config.min - 40) { target.style.width = `${original}px`; config.onCollapse(); }
      else { preview(); config.onCommit(next); }
    };
    const up = () => finish(false), cancel = () => finish(true);
    cleanup.current = cancel;
    setDragging(true);
    document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel); window.addEventListener("blur", cancel);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, []);
}
