// 恢复链路日志（release 可见的 cc-panes.log 追踪 + restore-log store 双写）。
// 从 TerminalView.tsx 拆出（纯代码移动，逻辑不变）。
import { useCallback } from "react";
import { info as logInfo } from "@tauri-apps/plugin-log";
import { useTerminalRestoreLogStore } from "@/stores";
import { terminalRestoreLaunchQueue, type RestoreLaunchState } from "../terminalRestoreQueue";

interface RefValue<T> {
  current: T;
}

export interface UseTerminalRestoreLoggerParams {
  tabId?: string;
  paneId?: string;
  projectPath: string;
  layoutActive?: boolean;
  restoring?: boolean;
  everHiddenRef: RefValue<boolean>;
  deferredRestoreRef: RefValue<boolean>;
  currentSessionIdRef: RefValue<string | null>;
  restoreLaunchStartedRef: RefValue<boolean>;
  onRestoreLaunchState?: (state: RestoreLaunchState) => void;
}

export function useTerminalRestoreLogger({
  tabId,
  paneId,
  projectPath,
  layoutActive,
  restoring,
  everHiddenRef,
  deferredRestoreRef,
  currentSessionIdRef,
  restoreLaunchStartedRef,
  onRestoreLaunchState,
}: UseTerminalRestoreLoggerParams) {
  // Release-visible restore trace (lands in cc-panes.log, unlike dev-only debugLog).
  const logRestoreEvent = useCallback((event: string, extra: Record<string, unknown> = {}) => {
    const details = {
      project: projectPath ?? null,
      layoutActive: layoutActive ?? true,
      restoring: restoring ?? false,
      everHidden: everHiddenRef.current,
      deferred: deferredRestoreRef.current,
      hasSession: Boolean(currentSessionIdRef.current),
      launchStarted: restoreLaunchStartedRef.current,
      ...extra,
    };
    if (tabId && paneId) {
      useTerminalRestoreLogStore.getState().append(tabId, paneId, event, details);
    }
    void logInfo(
      `[layout-restore] ${event} ${JSON.stringify({
        timestamp: new Date().toISOString(),
        tabId: tabId ?? null,
        paneId: paneId ?? null,
        ...details,
      })}`,
    ).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, paneId, projectPath, layoutActive, restoring]);
  const reportRestoreLaunchState = useCallback((state: RestoreLaunchState) => {
    onRestoreLaunchState?.(state);
    if (restoring) {
      logRestoreEvent(`queue.${state}`, terminalRestoreLaunchQueue.getSnapshot());
    }
  }, [logRestoreEvent, onRestoreLaunchState, restoring]);

  return { logRestoreEvent, reportRestoreLaunchState };
}
