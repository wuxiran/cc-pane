import { useEffect, useRef, useState, type PointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { toastErr } from "@/lib/feedback";
import { getErrorMessage } from "@/utils";

interface Gesture {
  id: number;
  version: number;
  x: number;
  y: number;
  dragging: boolean;
  position: Promise<{ x: number; y: number }>;
  latest?: { x: number; y: number };
}

export function usePetPointerGesture(onClick: () => void, onMenu: () => void) {
  const [interacting, setInteracting] = useState(false);
  const current = useRef<Gesture | null>(null);
  const version = useRef(0);
  const moves = useRef(Promise.resolve());
  const suppressClick = useRef(false);

  useEffect(() => () => { version.current++; current.current = null; }, []);

  function move(gesture: Gesture, x: number, y: number, persist: boolean) {
    const target = { x, y };
    gesture.latest = target;
    moves.current = moves.current.then(async () => {
      const start = await gesture.position;
      if (version.current !== gesture.version || (!persist && gesture.latest !== target)) return;
      // DOM screenX/Y are CSS pixels; outerPosition is physical pixels.
      await invoke("move_ccchan_window", { x: start.x + x - gesture.x, y: start.y + y - gesture.y, persist });
    }).catch((error) => { toastErr(getErrorMessage(error)); });
    return moves.current;
  }

  return {
    interacting,
    onClick: () => {
      if (suppressClick.current) { suppressClick.current = false; return; }
      onClick();
    },
    onPointerDown(event: PointerEvent<HTMLButtonElement>) {
      if (event.button === 2) { event.preventDefault(); onMenu(); return; }
      if (event.button !== 0) return;
      suppressClick.current = false;
      const win = getCurrentWindow();
      const position = Promise.all([win.outerPosition(), win.scaleFactor()])
        .then(([point, scale]) => ({ x: point.x / scale, y: point.y / scale }));
      // Attach immediately so a failed lookup without any movement is handled.
      void position.catch((error) => { toastErr(getErrorMessage(error)); });
      current.current = { id: event.pointerId, version: ++version.current, x: event.screenX, y: event.screenY, dragging: false, position };
      setInteracting(true);
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* unsupported in some webviews */ }
    },
    onPointerMove(event: PointerEvent<HTMLButtonElement>) {
      const gesture = current.current;
      if (!gesture || gesture.id !== event.pointerId) return;
      if (!gesture.dragging && Math.hypot(event.screenX - gesture.x, event.screenY - gesture.y) < 5) return;
      gesture.dragging = true;
      void move(gesture, event.screenX, event.screenY, false);
    },
    onPointerUp(event: PointerEvent<HTMLButtonElement>) {
      const gesture = current.current;
      if (!gesture || gesture.id !== event.pointerId) return;
      current.current = null;
      try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* capture may already be lost */ }
      suppressClick.current = true;
      if (gesture.dragging || Math.hypot(event.screenX - gesture.x, event.screenY - gesture.y) >= 5) {
        void move(gesture, event.screenX, event.screenY, true).finally(() => setInteracting(false));
      } else { setInteracting(false); onClick(); }
    },
    onPointerCancel() {
      version.current++;
      current.current = null;
      suppressClick.current = true;
      setInteracting(false);
    },
  };
}
