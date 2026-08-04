import type { Terminal } from "@xterm/xterm";

import { terminalService } from "@/services/terminalService";
import { getErrorMessage } from "@/utils";
import {
  createTerminalOutputHandler,
  flushHiddenOutputBeforeExit,
} from "./terminalOutputHandler";
import { createTerminalDesyncHandler } from "./terminalResync";
import type { TerminalHiddenWriteBuffer } from "./terminalHiddenWriteBuffer";
import type { TerminalLayoutScheduler } from "./terminalLayoutScheduler";

interface RefValue<T> {
  current: T;
}
type BindingLogger = (event: string, payload?: Record<string, unknown>) => void;

export interface PendingSessionExit {
  sessionId: string;
  exitCode: number;
}

interface CreateTerminalExitHandlerOptions {
  terminalInstanceRef: RefValue<Terminal | null>;
  hiddenWriteBufferRef: RefValue<TerminalHiddenWriteBuffer | null>;
  writeTerminalData: (data: string, onWritten?: () => void) => Promise<void>;
  syncTrackedBufferType: (reason: string) => void;
  isSshRef: RefValue<boolean>;
  onReconnectRef: RefValue<(() => Promise<string | null>) | null | undefined>;
  isDisconnectedRef: RefValue<boolean>;
  onSessionExited: (exitCode: number) => void;
  /** resync 在途时到达的 exit 必须挂起，否则横幅会被快照 reset 抹掉。 */
  resyncActiveRef: RefValue<boolean>;
  pendingExitRef: RefValue<PendingSessionExit | null>;
  debugLog: BindingLogger;
}

/** 会话退出的标准处理（从 TerminalView 抽出，行数棘轮）：resync 闸门挂起 + 积压先冲刷再横幅。 */
export function createTerminalExitHandler({
  terminalInstanceRef,
  hiddenWriteBufferRef,
  writeTerminalData,
  syncTrackedBufferType,
  isSshRef,
  onReconnectRef,
  isDisconnectedRef,
  onSessionExited,
  resyncActiveRef,
  pendingExitRef,
  debugLog,
}: CreateTerminalExitHandlerOptions): (sessionId: string, exitCode: number) => void {
  return (sessionId, exitCode) => {
    console.warn(`[TerminalView] Session exited: ${sessionId}, exitCode=${exitCode}`);
    if (resyncActiveRef.current) {
      pendingExitRef.current = { sessionId, exitCode };
      return;
    }
    const term = terminalInstanceRef.current;
    if (!term) return;
    flushHiddenOutputBeforeExit({
      term,
      exitCode,
      hiddenWriteBuffer: hiddenWriteBufferRef.current,
      writeTerminalData,
      syncTrackedBufferType,
      showReconnectHint: Boolean(isSshRef.current && onReconnectRef.current),
      onSessionExited: () => {
        if (isSshRef.current && onReconnectRef.current) isDisconnectedRef.current = true;
        onSessionExited(exitCode);
      },
      onError: (error) =>
        debugLog("output.hidden.exit-flush.failed", { error: getErrorMessage(error) }),
    });
  };
}

export interface BindTerminalSessionCallbacksOptions {
  terminalInstanceRef: RefValue<Terminal | null>;
  focusReportModeRef: RefValue<boolean>;
  hiddenWriteBufferRef: RefValue<TerminalHiddenWriteBuffer | null>;
  layoutSchedulerRef: RefValue<TerminalLayoutScheduler | null>;
  outputUnsubRef: RefValue<(() => void) | null>;
  exitUnsubRef: RefValue<(() => void) | null>;
  desyncUnsubRef: RefValue<(() => void) | null>;
  /** 可见性判定；输出直写门槛由此与重同步闸门共同组成。 */
  isRenderVisible: () => boolean;
  keepCliOutputInNormalBuffer: boolean;
  renderTerminalData: (data: string) => string;
  writeTerminalData: (data: string, onWritten?: () => void) => Promise<void>;
  syncTrackedBufferType: (reason: string) => void;
  /** 换绑前注销旧订阅（重连等场景），避免旧回调残留。 */
  unbindSessionCallbacks: () => void;
  onSessionExit: (sessionId: string, exitCode: number) => void;
  /** desync 重同步闸门（见 createTerminalDesyncHandler 的时序契约）。 */
  resyncActiveRef: RefValue<boolean>;
  /** 闸门收尾放行：flush 闸门期积压。 */
  flushHiddenWrites: (reason: string) => void;
  /** resync 期间挂起的 exit，收尾时补执行（经 onSessionExit）。 */
  pendingExitRef: RefValue<PendingSessionExit | null>;
  debugLog: BindingLogger;
}

/** 输出/退出/desync 三路订阅的标准接线（从 TerminalView 抽出，行数棘轮）。 */
export async function bindTerminalSessionCallbacks(
  sessionId: string,
  {
    terminalInstanceRef,
    focusReportModeRef,
    hiddenWriteBufferRef,
    layoutSchedulerRef,
    outputUnsubRef,
    exitUnsubRef,
    desyncUnsubRef,
    isRenderVisible,
    keepCliOutputInNormalBuffer,
    renderTerminalData,
    writeTerminalData,
    syncTrackedBufferType,
    unbindSessionCallbacks,
    onSessionExit,
    resyncActiveRef,
    flushHiddenWrites,
    pendingExitRef,
    debugLog,
  }: BindTerminalSessionCallbacksOptions,
): Promise<void> {
  debugLog("session.bind-callbacks.begin", { bindSessionId: sessionId });
  unbindSessionCallbacks();
  outputUnsubRef.current = await terminalService.registerOutput(
    sessionId,
    createTerminalOutputHandler({
      sessionId,
      terminalRef: terminalInstanceRef,
      focusReportModeRef,
      hiddenWriteBufferRef,
      // 输出直写门槛 = 可见 且 无重同步在途：闸门期实时输出必须进积压，
      // 否则会赶在快照 reset 前落地随后被抹掉（真丢失）。
      isRenderVisible: () => isRenderVisible() && !resyncActiveRef.current,
      keepCliOutputInNormalBuffer,
      renderTerminalData,
      writeTerminalData,
      syncTrackedBufferType,
      debugLog,
    }),
  );
  exitUnsubRef.current = await terminalService.registerExit(sessionId, (exitCode) => {
    onSessionExit(sessionId, exitCode);
  });
  desyncUnsubRef.current = await terminalService.registerDesync(
    sessionId,
    createTerminalDesyncHandler({
      sessionId,
      terminalRef: terminalInstanceRef,
      hiddenWriteBufferRef,
      getReplaySnapshot: (id) => terminalService.getReplaySnapshot(id),
      writeData: (data) => writeTerminalData(renderTerminalData(data)),
      syncTrackedBufferType,
      setResyncActive: (active) => {
        resyncActiveRef.current = active;
      },
      onResyncSettled: (resynced) => {
        flushHiddenWrites("resync.settled");
        // resync 期间挂起的 exit 在快照落地后补执行（此刻积压已 flush，
        // 退出横幅落在最终画面之上，不会再被 reset 抹掉）。
        const pendingExit = pendingExitRef.current;
        if (pendingExit) {
          pendingExitRef.current = null;
          onSessionExit(pendingExit.sessionId, pendingExit.exitCode);
        }
        if (resynced) {
          layoutSchedulerRef.current?.schedule("terminal.resync", {
            force: true,
            allowInactive: true,
          });
        }
      },
      debugLog,
    }),
  );
  debugLog("session.bind-callbacks.end", { bindSessionId: sessionId });
}
