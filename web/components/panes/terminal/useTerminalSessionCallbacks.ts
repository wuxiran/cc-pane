// 会话回调绑定：输出/退出/desync 订阅的挂接与注销、SSH 重连。
// 从 TerminalView.tsx 拆出（纯代码移动，逻辑不变）。
import { useCallback, useMemo } from "react";
import type { Terminal } from "@xterm/xterm";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { TerminalHiddenWriteBuffer } from "../terminalHiddenWriteBuffer";
import {
  bindTerminalSessionCallbacks,
  createTerminalExitHandler,
  type createHiddenWriteFlusher,
  type PendingSessionExit,
} from "../terminalSessionBinding";
import { reconnectTerminalSession } from "../terminalReconnect";
import type { TerminalLayoutScheduler } from "../terminalLayoutScheduler";

interface RefValue<T> {
  current: T;
}

export interface UseTerminalSessionCallbacksParams {
  terminalInstanceRef: RefValue<Terminal | null>;
  serializeAddonRef: RefValue<SerializeAddon | null>;
  layoutSchedulerRef: RefValue<TerminalLayoutScheduler | null>;
  currentSessionIdRef: RefValue<string | null>;
  hiddenWriteBufferRef: RefValue<TerminalHiddenWriteBuffer | null>;
  outputUnsubRef: RefValue<(() => void) | null>;
  exitUnsubRef: RefValue<(() => void) | null>;
  desyncUnsubRef: RefValue<(() => void) | null>;
  resyncInProgressRef: RefValue<boolean>;
  overflowResyncRef: RefValue<(() => Promise<boolean>) | null>;
  pendingExitDuringResyncRef: RefValue<PendingSessionExit | null>;
  isSshRef: RefValue<boolean>;
  isDisconnectedRef: RefValue<boolean>;
  isReconnectingRef: RefValue<boolean>;
  onReconnectRef: RefValue<(() => Promise<string | null>) | undefined>;
  onSessionExitedRef: RefValue<((exitCode: number) => void) | undefined>;
  keepCliOutputInNormalBuffer: boolean;
  isRenderVisible: () => boolean;
  renderTerminalData: (data: string) => string;
  renderCheckpointData: (data: string) => string;
  writeTerminalData: (data: string, onWritten?: () => void) => Promise<void>;
  syncTrackedBufferType: (reason: string) => void;
  flushHiddenWrites: ReturnType<typeof createHiddenWriteFlusher>;
  debugLog: (event: string, payload?: Record<string, unknown>) => void;
}

export function useTerminalSessionCallbacks({
  terminalInstanceRef,
  serializeAddonRef,
  layoutSchedulerRef,
  currentSessionIdRef,
  hiddenWriteBufferRef,
  outputUnsubRef,
  exitUnsubRef,
  desyncUnsubRef,
  resyncInProgressRef,
  overflowResyncRef,
  pendingExitDuringResyncRef,
  isSshRef,
  isDisconnectedRef,
  isReconnectingRef,
  onReconnectRef,
  onSessionExitedRef,
  keepCliOutputInNormalBuffer,
  isRenderVisible,
  renderTerminalData,
  renderCheckpointData,
  writeTerminalData,
  syncTrackedBufferType,
  flushHiddenWrites,
  debugLog,
}: UseTerminalSessionCallbacksParams) {
  /** 注销本视图自己的输出/退出订阅（不影响同会话的其他视图） */
  const unbindSessionCallbacks = useCallback(() => {
    outputUnsubRef.current?.();
    outputUnsubRef.current = null;
    exitUnsubRef.current?.();
    exitUnsubRef.current = null;
    desyncUnsubRef.current?.();
    desyncUnsubRef.current = null;
    // 换绑/重连时丢弃积压：上一会话的输出串进新会话会直接写坏画面。
    hiddenWriteBufferRef.current?.reset(); // reset 内部一并退出全局预算分母
    pendingExitDuringResyncRef.current = null; // 挂起 exit/闸门/恢复入口同弃，防串新会话
    resyncInProgressRef.current = false;
    overflowResyncRef.current = null;
  }, []);

  const handleSessionExit = useMemo(
    () =>
      createTerminalExitHandler({
        terminalInstanceRef,
        hiddenWriteBufferRef,
        writeTerminalData,
        syncTrackedBufferType,
        isSshRef,
        onReconnectRef,
        isDisconnectedRef,
        onSessionExited: (exitCode) => onSessionExitedRef.current?.(exitCode),
        resyncActiveRef: resyncInProgressRef,
        pendingExitRef: pendingExitDuringResyncRef,
        debugLog,
      }),
    [debugLog, syncTrackedBufferType, writeTerminalData],
  );

  /** Attach output, exit, and desync listeners for a session. */
  const bindSessionCallbacks = useCallback(async (sessionId: string) => {
    await bindTerminalSessionCallbacks(sessionId, {
      terminalInstanceRef,
      serializeAddonRef,
      hiddenWriteBufferRef,
      layoutSchedulerRef,
      outputUnsubRef,
      exitUnsubRef,
      desyncUnsubRef,
      isRenderVisible,
      keepCliOutputInNormalBuffer,
      renderTerminalData,
      renderCheckpointData,
      writeTerminalData,
      syncTrackedBufferType,
      unbindSessionCallbacks,
      onSessionExit: handleSessionExit,
      resyncActiveRef: resyncInProgressRef,
      overflowResyncRef,
      flushHiddenWrites,
      pendingExitRef: pendingExitDuringResyncRef,
      debugLog,
    });
  }, [
    debugLog,
    flushHiddenWrites,
    handleSessionExit,
    isRenderVisible,
    keepCliOutputInNormalBuffer,
    renderCheckpointData,
    renderTerminalData,
    syncTrackedBufferType,
    unbindSessionCallbacks,
    writeTerminalData,
  ]);

  /** Attempt to reconnect an SSH-backed session. */
  const doReconnect = useCallback(
    () =>
      reconnectTerminalSession({
        terminalInstanceRef,
        isReconnectingRef,
        isDisconnectedRef,
        currentSessionIdRef,
        onReconnectRef,
        unbindSessionCallbacks,
        bindSessionCallbacks,
      }),
    [bindSessionCallbacks, unbindSessionCallbacks],
  );

  return {
    unbindSessionCallbacks,
    handleSessionExit,
    bindSessionCallbacks,
    doReconnect,
  };
}
