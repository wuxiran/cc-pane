// 容器尺寸监听 → 布局调度。拖动中降频直 flush，平时 150ms 防抖 schedule。
// 从 TerminalView.tsx 拆出（纯代码移动，逻辑不变）。
import { isDragging } from "@/stores/splitDragState";
import type { TerminalLayoutScheduler } from "../terminalLayoutScheduler";

interface RefValue<T> {
  current: T;
}

export interface TerminalResizeObserverDeps {
  isMounted: () => boolean;
  layoutSchedulerRef: RefValue<TerminalLayoutScheduler | null>;
  lastDragFitAtRef: RefValue<number>;
}

/** Keep pane dragging responsive without fitting on every pointer move. */
export function createTerminalResizeObserver({
  isMounted,
  layoutSchedulerRef,
  lastDragFitAtRef,
}: TerminalResizeObserverDeps): ResizeObserver {
  const MIN_CONTAINER_CHANGE = 5;
  const DRAG_CONTAINER_CHANGE = 20;
  const DRAG_FIT_INTERVAL_MS = 80;
  return new ResizeObserver((entries) => {
    if (!isMounted()) return;
    const entry = entries[0];
    if (!entry) return;

    const { width, height } = entry.contentRect;
    if (isDragging()) {
      const now = performance.now();
      if (now - lastDragFitAtRef.current < DRAG_FIT_INTERVAL_MS) return;
      lastDragFitAtRef.current = now;
      layoutSchedulerRef.current?.flush("resize-observer.drag.fit", {
        containerSize: { width, height },
        minContainerDelta: DRAG_CONTAINER_CHANGE,
        // 隐藏也允许：容器尺寸真实变了就得跟，恢复可见时才不错位
        allowInactive: true,
      });
      return;
    }

    layoutSchedulerRef.current?.schedule("resize-observer.fit", {
      delayMs: 150,
      containerSize: { width, height },
      minContainerDelta: MIN_CONTAINER_CHANGE,
      // 隐藏也允许：同上，容器实际尺寸变化不看焦点
      allowInactive: true,
    });
  });
}
