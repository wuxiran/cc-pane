import { useRef, type PointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const DRAG_THRESHOLD = 4;

/**
 * 左键：不动松手 = 点击；移动超过阈值 = 交给系统原生拖拽（startDragging）。
 * 原生拖拽在混合 DPI 下坐标正确、跟手，松手后的吸附与位置持久化在后端
 * （WindowEvent::Moved 停稳后统一处理），前端不再自己算窗口坐标。
 * 原生拖拽开始后 pointerup 可能被系统吞掉，所以一旦进入拖拽就直接结束手势。
 */
export function usePetPointerGesture(onClick: () => void) {
  const gesture = useRef<{ id: number; x: number; y: number } | null>(null);

  return {
    onPointerDown(event: PointerEvent<HTMLButtonElement>) {
      // 右键菜单走 contextmenu 事件（只弹一次），这里只管左键。
      if (event.button !== 0) return;
      gesture.current = { id: event.pointerId, x: event.screenX, y: event.screenY };
    },
    onPointerMove(event: PointerEvent<HTMLButtonElement>) {
      const current = gesture.current;
      if (!current || current.id !== event.pointerId) return;
      if (Math.hypot(event.screenX - current.x, event.screenY - current.y) < DRAG_THRESHOLD) return;
      gesture.current = null;
      void getCurrentWindow()
        .startDragging()
        .catch((error: unknown) => console.warn("[ccchan] start dragging failed:", error));
    },
    onPointerUp(event: PointerEvent<HTMLButtonElement>) {
      const current = gesture.current;
      if (!current || current.id !== event.pointerId) return;
      gesture.current = null;
      onClick();
    },
    onPointerCancel() {
      gesture.current = null;
    },
  };
}
