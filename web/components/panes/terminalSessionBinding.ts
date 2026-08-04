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
  /**
   * 对外暴露重同步入口：隐藏积压溢出的可见性回归走同一条 snapshot 重放路
   * （语义与 daemon desync 完全一致——积压带缺口，flush 必花屏）。解绑时置空。
   */
  overflowResyncRef: RefValue<(() => void) | null>;
  /** 闸门收尾放行：flush 闸门期积压。 */
  flushHiddenWrites: (reason: string) => void;
  /** resync 期间挂起的 exit，收尾时补执行（经 onSessionExit）。 */
  pendingExitRef: RefValue<PendingSessionExit | null>;
  debugLog: BindingLogger;
}

/**
 * snapshot 重放失败（快照缺失/请求失败）时的兜底提示：画面可能有缺口，
 * 指路右键「刷新终端显示」（Refresh Terminal Display）——它会强制 resize 让
 * CLI 自行重绘，TUI 场景基本都能救回来。不能静默留残画面。
 */
const RESYNC_FAILED_NOTICE =
  "\r\n\x1b[33m[CC-Panes] Some output could not be restored. " +
  'Right-click → "Refresh Terminal Display" to force a redraw.\x1b[0m\r\n';

interface CreateHiddenWriteFlusherOptions {
  hiddenWriteBufferRef: RefValue<TerminalHiddenWriteBuffer | null>;
  resyncActiveRef: RefValue<boolean>;
  overflowResyncRef: RefValue<(() => void) | null>;
  writeTerminalData: (data: string, onWritten?: () => void) => Promise<void>;
  syncTrackedBufferType: (reason: string) => void;
  debugLog: BindingLogger;
}

/** 把不可见期间攒下的输出一次性写进 xterm（可见性回归/收尾统一入口）。 */
export function createHiddenWriteFlusher({
  hiddenWriteBufferRef,
  resyncActiveRef,
  overflowResyncRef,
  writeTerminalData,
  syncTrackedBufferType,
  debugLog,
}: CreateHiddenWriteFlusherOptions): (reason: string) => void {
  return (reason) => {
    // 重同步在途时推迟，收尾（onResyncSettled）统一放行。
    if (resyncActiveRef.current) return;
    // 积压溢出（带缺口）：flush 必花屏，改走 snapshot 重放自动恢复画面。
    if (hiddenWriteBufferRef.current?.didOverflow() && overflowResyncRef.current) {
      debugLog("output.hidden.overflow-resync", { reason });
      overflowResyncRef.current();
      return;
    }
    const pending = hiddenWriteBufferRef.current?.drain();
    if (!pending) return;
    debugLog("output.hidden.flush", { reason, length: pending.length });
    void writeTerminalData(pending, () => {
      syncTrackedBufferType("output.hidden.flush");
    }).catch((error) => {
      debugLog("output.hidden.flush.failed", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
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
    overflowResyncRef,
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
  const resyncHandler = createTerminalDesyncHandler({
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
        } else {
          // 恢复失败不能哑掉：残画面 + 一条指路提示（右键刷新可让 CLI 重绘）。
          void writeTerminalData(RESYNC_FAILED_NOTICE).catch(() => {});
        }
      },
      debugLog,
    });
  desyncUnsubRef.current = await terminalService.registerDesync(sessionId, resyncHandler);
  overflowResyncRef.current = resyncHandler;
  debugLog("session.bind-callbacks.end", { bindSessionId: sessionId });
}
