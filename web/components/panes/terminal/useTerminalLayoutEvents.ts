// 布局变更 / 全部重排事件 → 布局调度。从 TerminalView.tsx 拆出（纯代码移动，逻辑不变）。
import { useEffect, useRef } from "react";
import { TERMINAL_LAYOUT_CHANGED_EVENT } from "@/stores";
import { TERMINAL_FIT_ALL_EVENT } from "../terminalFitEvents";
import type { TerminalLayoutScheduler } from "../terminalLayoutScheduler";

interface RefValue<T> {
  current: T;
}

export interface UseTerminalLayoutEventsParams {
  layoutActive: boolean;
  layoutActiveRef: RefValue<boolean>;
  layoutSchedulerRef: RefValue<TerminalLayoutScheduler | null>;
  refreshDisplay?: (reason: string) => void;
  debugLog: (event: string, payload?: Record<string, unknown>) => void;
}

/** 切到本布局的那一帧：hidden → visible。首屏挂载不算。 */
export function didLayoutBecomeVisible(
  previous: boolean | undefined,
  next: boolean,
): boolean {
  return previous === false && next;
}

export function useTerminalLayoutEvents({
  layoutActive,
  layoutActiveRef,
  layoutSchedulerRef,
  refreshDisplay,
  debugLog,
}: UseTerminalLayoutEventsParams): void {
  const previousLayoutActiveRef = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    const previous = previousLayoutActiveRef.current;
    previousLayoutActiveRef.current = layoutActive;
    if (!didLayoutBecomeVisible(previous, layoutActive)) return;
    debugLog("layout.activated.refresh", {});
    layoutSchedulerRef.current?.schedule("layout.activated", {
      force: true,
      allowInactive: true,
    });
    refreshDisplay?.("layout.activated");
  }, [debugLog, layoutActive, layoutSchedulerRef, refreshDisplay]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleLayoutChanged = (event: Event) => {
      if (!layoutActiveRef.current) return;
      const reason =
        event instanceof CustomEvent && typeof event.detail?.reason === "string"
          ? event.detail.reason
          : "layout";
      // schedule 内部双 RAF 执行，保证 fit 落在 React commit 之后
      // （store 事件的 RAF 派发可能早于非批处理路径的 commit），连发事件自动合并。
      debugLog("layout-change.refit.schedule", { reason });
      layoutSchedulerRef.current?.schedule(`layout-change.${reason}`, {
        force: true,
        // 隐藏也允许：布局变更时所有格子都要重排（含 display:none 的
        // 非焦点格），否则切回时尺寸是旧的
        allowInactive: true,
      });
      // fit 的 repaint 只 refresh，WebGL 会 skip 未改格子。切布局时强制重建显示。
      refreshDisplay?.(`layout-change.${reason}`);
    };

    const handleFitAll = () => {
      if (!layoutActiveRef.current) return;
      layoutSchedulerRef.current?.schedule("context-menu.fit-all", {
        force: true,
        forceBackendSync: true,
        // 隐藏也允许：用户显式要求全部重排，非焦点格一并处理
        allowInactive: true,
      });
    };
    window.addEventListener(TERMINAL_LAYOUT_CHANGED_EVENT, handleLayoutChanged);
    window.addEventListener(TERMINAL_FIT_ALL_EVENT, handleFitAll);
    return () => {
      window.removeEventListener(TERMINAL_LAYOUT_CHANGED_EVENT, handleLayoutChanged);
      window.removeEventListener(TERMINAL_FIT_ALL_EVENT, handleFitAll);
    };
  }, [debugLog]);
}
