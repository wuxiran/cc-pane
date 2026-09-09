import type { Terminal } from "@xterm/xterm";

import { registerCheckpointRequest } from "@/services/terminalCheckpoint";
import { getRecoverySnapshot } from "@/services/terminalRecovery";
import { terminalService } from "@/services/terminalService";
import { getErrorMessage } from "@/utils";
import { captureAndUploadCheckpoint, type CheckpointSerializer } from "./terminalCheckpointUpload";
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
export type HiddenWriteFlushOutcome = "ready" | "resync";
type TerminalResyncHandler = () => Promise<boolean>;

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
  /** 拍照用 serialize addon（M3b-2 daemon 补拍触发点）；不传 = 本视图不响应补拍。 */
  serializeAddonRef?: RefValue<CheckpointSerializer | null>;
  hiddenWriteBufferRef: RefValue<TerminalHiddenWriteBuffer | null>;
  layoutSchedulerRef: RefValue<TerminalLayoutScheduler | null>;
  outputUnsubRef: RefValue<(() => void) | null>;
  exitUnsubRef: RefValue<(() => void) | null>;
  desyncUnsubRef: RefValue<(() => void) | null>;
  /** 可见性判定；输出直写门槛由此与重同步闸门共同组成。 */
  isRenderVisible: () => boolean;
  keepCliOutputInNormalBuffer: boolean;
  renderTerminalData: (data: string) => string;
  /** photo 管道渲染：只剥 SGR 背景色，不做 alt-screen 剥离（见 stripSgrBackgroundColors）。 */
  renderCheckpointData: (data: string) => string;
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
  overflowResyncRef: RefValue<TerminalResyncHandler | null>;
  /** 闸门收尾放行：flush 闸门期积压。 */
  flushHiddenWrites: (reason: string) => Promise<HiddenWriteFlushOutcome>;
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
  overflowResyncRef: RefValue<TerminalResyncHandler | null>;
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
}: CreateHiddenWriteFlusherOptions): (reason: string) => Promise<HiddenWriteFlushOutcome> {
  let writeInFlight: Promise<void> | null = null;

  return async (reason) => {
    // 重同步在途时共享它的完成屏障；最终 flush/refit 由 onResyncSettled 负责。
    if (resyncActiveRef.current) {
      await overflowResyncRef.current?.();
      return "resync";
    }
    // 积压溢出（带缺口）：flush 必花屏，改走 snapshot 重放自动恢复画面。
    if (hiddenWriteBufferRef.current?.didOverflow() && overflowResyncRef.current) {
      debugLog("output.hidden.overflow-resync", { reason });
      await overflowResyncRef.current();
      return "resync";
    }
    const pending = hiddenWriteBufferRef.current?.drain();
    if (!pending) {
      await writeInFlight;
      return "ready";
    }
    debugLog("output.hidden.flush", { reason, length: pending.length });
    const previousWrite = writeInFlight;
    const currentWrite = (async () => {
      await previousWrite;
      try {
        await writeTerminalData(pending, () => {
          syncTrackedBufferType("output.hidden.flush");
        });
      } catch (error) {
        debugLog("output.hidden.flush.failed", {
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    writeInFlight = currentWrite;
    try {
      await currentWrite;
    } finally {
      if (writeInFlight === currentWrite) writeInFlight = null;
    }
    return "ready";
  };
}

interface RestoreVisibleTerminalViewOptions {
  flushHiddenWrites: (reason: string) => Promise<HiddenWriteFlushOutcome>;
  isRenderVisible: () => boolean;
  scheduleRefit: () => void;
}

/** Keep a visible-edge refit from racing xterm while it consumes hidden output. */
export async function restoreVisibleTerminalView({
  flushHiddenWrites,
  isRenderVisible,
  scheduleRefit,
}: RestoreVisibleTerminalViewOptions): Promise<void> {
  const outcome = await flushHiddenWrites("view.visible-edge");
  if (outcome === "resync" || !isRenderVisible()) return;
  scheduleRefit();
}

/** 输出/退出/desync 三路订阅的标准接线（从 TerminalView 抽出，行数棘轮）。 */
export async function bindTerminalSessionCallbacks(
  sessionId: string,
  {
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
      isRenderVisible,
      sessionId,
      terminalRef: terminalInstanceRef,
      hiddenWriteBufferRef,
      getRecoverySnapshot: (id) => getRecoverySnapshot(id),
      // 双管道（裁决 B）：delta 过 renderTerminalData；photo 是成品 VT，
      // 只过 renderCheckpointData（剥背景色，不剥 alt-screen）。
      writeData: (data) => writeTerminalData(renderTerminalData(data)),
      writeCheckpointData: (data) => writeTerminalData(renderCheckpointData(data)),
      syncTrackedBufferType,
      setResyncActive: (active) => {
        resyncActiveRef.current = active;
      },
      onResyncSettled: async (resynced) => {
        const flushOutcome = await flushHiddenWrites("resync.settled");
        if (flushOutcome === "resync") return;
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
  const desyncUnsub = await terminalService.registerDesync(sessionId, resyncHandler);
  // daemon 补拍请求（M3b-2 触发点③）：与 desync 同为会话级订阅、同一绑定生命周期，
  // 注销复用 desyncUnsubRef 承载（TerminalView 贴着行数棘轮，不再穿新 ref）。
  const checkpointRequestUnsub = await registerCheckpointRequest(sessionId, () => {
    void captureAndUploadCheckpoint(
      sessionId,
      terminalInstanceRef.current,
      serializeAddonRef?.current ?? null,
      { reason: "daemon-request" },
    );
  });
  desyncUnsubRef.current = () => {
    resyncHandler.dispose();
    // 可选调用：测试替身的 registerDesync/registerCheckpointRequest 可能不返回
    // unsubscribe（真实实现恒返回函数）。
    desyncUnsub?.();
    checkpointRequestUnsub?.();
  };
  overflowResyncRef.current = resyncHandler;
  debugLog("session.bind-callbacks.end", { bindSessionId: sessionId });
}
