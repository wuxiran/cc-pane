import type { Terminal } from "@xterm/xterm";

import type { TerminalResyncTrigger } from "./terminalResync";
import { registerCheckpointRequest } from "@/services/terminalCheckpoint";
import { getRecoverySnapshot } from "@/services/terminalRecovery";
import { clearTerminalOutputDesyncLatch, terminalService } from "@/services/terminalService";
import { getErrorMessage } from "@/utils";
import { captureAndUploadCheckpoint, type CheckpointSerializer } from "./terminalCheckpointUpload";
import {
  createTerminalOutputHandler,
  flushHiddenOutputBeforeExit,
} from "./terminalOutputHandler";
import { createTerminalDesyncHandler } from "./terminalResync";
import { takeCurrentTerminalDeliveryCredit } from "./terminalDeliveryCredit";
import { invalidateSeq, noteBacklogReplayed, receivedThroughSeq } from "./terminalOutputSeqTracker";
import { isSecondaryTerminalView, takeRecoveryFloor } from "./terminalViewOwnership";
import { createResyncGateBacklog, createSnapshotReconciler, type SeqChunk } from "./terminalSnapshotOverlap";
import type { TerminalRecoverySnapshot } from "@/types";
import type { TerminalHiddenWriteBuffer } from "./terminalHiddenWriteBuffer";
import type { TerminalLayoutScheduler } from "./terminalLayoutScheduler";

interface RefValue<T> {
  current: T;
}
type BindingLogger = (event: string, payload?: Record<string, unknown>) => void;
export type HiddenWriteFlushOutcome = "ready" | "resync";
type TerminalResyncHandler = TerminalResyncTrigger;

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
  renderTerminalData: (data: string, options?: { discontinuity?: boolean }) => string;
  /** photo 管道渲染：只剥 SGR 背景色，不做 alt-screen 剥离（见 stripSgrBackgroundColors）。 */
  renderCheckpointData: (data: string) => string;
  writeTerminalData: (data: string, onWritten?: () => void) => Promise<void>;
  syncTrackedBufferType: (reason: string) => void;
  /** 换绑前注销旧订阅（重连等场景），避免旧回调残留。 */
  unbindSessionCallbacks: () => void;
  /** 每收到一个输出 chunk 打时间戳（watchdog D 输出饿死检测的对照锚点）。 */
  lastOutputReceivedAtRef?: RefValue<number>;
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
 * 指路右键「修复显示」（Repair Display）——它会强制 resize 让
 * CLI 自行重绘，TUI 场景基本都能救回来。不能静默留残画面。
 */
const RESYNC_FAILED_NOTICE =
  "\r\n\x1b[33m[CC-Panes] Some output could not be restored. " +
  'Right-click → "Repair Display" to force a redraw.\x1b[0m\r\n';

/** 因漏收输出而自动重建的次数上限（每个绑定、每个时间窗）。 */
const MAX_GAP_RESYNCS_PER_WINDOW = 3;
const GAP_RESYNC_WINDOW_MS = 30_000;

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
  /** 丢 WebGL skip 缓存整屏重绘：refit 只 refresh 已改格子，隐藏期的旧像素会残留。 */
  refreshDisplay?: (reason: string) => void;
}

/** Keep a visible-edge refit from racing xterm while it consumes hidden output. */
export async function restoreVisibleTerminalView({
  flushHiddenWrites,
  isRenderVisible,
  scheduleRefit,
  refreshDisplay,
}: RestoreVisibleTerminalViewOptions): Promise<void> {
  const outcome = await flushHiddenWrites("view.visible-edge");
  if (outcome === "resync" || !isRenderVisible()) return;
  scheduleRefit();
  refreshDisplay?.("view.visible-edge");
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
    lastOutputReceivedAtRef,
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
  const gateBacklog = createResyncGateBacklog();
  /** 本轮快照请求发出前已暂存的片数（旧后端无 seq 时按它丢弃，见 onResyncSettled）。 */
  let chunksBeforeRequest = 0;
  let lastRecoverySnapshot: TerminalRecoverySnapshot | null = null;
  // 共享的 seq 账本只归主视图（terminalViewOwnership.ts）。
  const ownsSeqLedger = () => !isSecondaryTerminalView(terminalInstanceRef.current);
  const outputHandler = createTerminalOutputHandler({
    sessionId,
    ownsSeqLedger,
    terminalRef: terminalInstanceRef,
    hiddenWriteBufferRef,
    // 输出直写门槛 = 可见 且 无重同步在途：闸门期实时输出必须进积压，
    // 否则会赶在快照 reset 前落地随后被抹掉（真丢失）。
    // 闸门期的输出不到这里（下面的订阅回调直接收进 gateBacklog），这条判断是兜底。
    isRenderVisible: () => isRenderVisible() && !resyncActiveRef.current,
    keepCliOutputInNormalBuffer,
    renderTerminalData,
    writeTerminalData,
    syncTrackedBufferType,
    debugLog,
  });
  /** 对账后确定要写的一块：推进 seq 账本并交给正常写入管线。 */
  const deliverReconciled = (chunk: SeqChunk): Promise<void> | undefined => {
    if (chunk.endSeq !== undefined && ownsSeqLedger()) noteBacklogReplayed(sessionId, chunk.endSeq);
    return outputHandler(chunk.data, chunk.endSeq);
  };
  // 本视图漏收了一段输出时用一份新快照重建。有次数上限：如果「漏收」其实是坐标
  // 推算出了偏差，不能没完没了地重置画面。
  const gapResyncAt: number[] = [];
  const resyncForGap = (reason: string, floorSeq: number, missingThroughSeq: number): boolean => {
    const now = Date.now();
    while (gapResyncAt.length > 0 && now - gapResyncAt[0] > GAP_RESYNC_WINDOW_MS) gapResyncAt.shift();
    const resync = overflowResyncRef.current;
    if (!resync || gapResyncAt.length >= MAX_GAP_RESYNCS_PER_WINDOW) {
      debugLog("output.reconcile.gap-ignored", { bindSessionId: sessionId, reason, floorSeq, missingThroughSeq });
      return false;
    }
    gapResyncAt.push(now);
    debugLog("output.reconcile.gap-resync", { bindSessionId: sessionId, reason, floorSeq, missingThroughSeq });
    void resync();
    return true;
  };
  // 快照已包含的输出不再写第二遍（terminalSnapshotOverlap.ts）。闸门期暂存、放闸之后
  // 才迟到的帧、订阅前暂存的输出都过它；一帧越过快照边界后自动停用，回到直通。
  const reconciler = createSnapshotReconciler({
    onGap: (floorSeq, frameStartSeq) => resyncForGap("frame-after-gap", floorSeq, frameStartSeq),
    onHoldTimeout: (chunk) => {
      debugLog("output.reconcile.hold-timeout", { bindSessionId: sessionId, length: chunk.data.length });
      void deliverReconciled(chunk);
    },
  });
  // 先回放、后绑定的路径（attach / 唤醒）：回放的重锚留下了它覆盖到的 endSeq。
  const attachFloorSeq = takeRecoveryFloor(terminalInstanceRef.current);
  if (attachFloorSeq !== null) reconciler.arm(attachFloorSeq);
  outputUnsubRef.current = await terminalService.registerOutput(
    sessionId,
    (data: string, endSeq?: number) => {
      if (lastOutputReceivedAtRef) lastOutputReceivedAtRef.current = Date.now();
      if (resyncActiveRef.current) {
        // 重同步闸门期：存原始数据 + endSeq，不过渲染变换。快照写完后按它的 endSeq
        // 去掉已包含的部分再补写——先渲染再积压会丢掉 seq，重叠段只能整段重复写入。
        const releaseCredit = takeCurrentTerminalDeliveryCredit() ?? (() => {});
        gateBacklog.push(data, endSeq);
        if (ownsSeqLedger()) invalidateSeq(sessionId);
        // 流控信用照常归还：字节已进前端自有的有界暂存（见 terminalOutputHandler）。
        releaseCredit();
        return;
      }
      if (reconciler.active()) {
        // 对账中：这一片可能被丢弃（快照已包含）、被攒着等帧尾、或裁掉重叠后放行。
        // 信用在这里归还——字节已由前端接手，不能等一个可能不会发生的写入回调。
        const releaseCredit = takeCurrentTerminalDeliveryCredit() ?? (() => {});
        const ready = reconciler.accept(data, endSeq);
        releaseCredit();
        for (const chunk of ready) void deliverReconciled(chunk);
        return;
      }
      outputHandler(data, endSeq);
    },
  );
  const hiddenQueryUnsub = terminalService.registerHiddenTerminalQueryHandler(sessionId, (data) => {
    const term = terminalInstanceRef.current;
    if (!term) return;
    // Queries have no visual payload; feed them directly to xterm's parser so
    // its existing CPR/DA/OSC handlers can answer while the pane is hidden.
    void term.write(data);
  });
  exitUnsubRef.current = await terminalService.registerExit(sessionId, (exitCode) => {
    onSessionExit(sessionId, exitCode);
  });
  const resyncHandler = createTerminalDesyncHandler({
      isRenderVisible,
      sessionId,
      terminalRef: terminalInstanceRef,
      hiddenWriteBufferRef,
      getRecoverySnapshot: async (id) => {
        lastRecoverySnapshot = null;
        lastRecoverySnapshot = await getRecoverySnapshot(id);
        return lastRecoverySnapshot;
      },
      // 双管道（裁决 B）：delta 过 renderTerminalData；photo 是成品 VT，
      // 只过 renderCheckpointData（剥背景色，不剥 alt-screen）。
      writeData: (data) => writeTerminalData(renderTerminalData(data)),
      writeCheckpointData: (data) => writeTerminalData(renderCheckpointData(data)),
      syncTrackedBufferType,
      setResyncActive: (active) => {
        resyncActiveRef.current = active;
      },
      onResyncStart: () => {
        renderTerminalData("", { discontinuity: true });
        // 上一轮对账攒着的片属于即将被快照替换的画面。
        reconciler.disarm();
        // 已溢出的暂存缺了中段，但缺的都在这轮快照之前，快照会包含：整段作废重收。
        // 没溢出的留着——恢复失败时它们是唯一还在的尾部；成功时由 endSeq 对账裁掉。
        if (gateBacklog.overflowed()) gateBacklog.reset();
        chunksBeforeRequest = gateBacklog.count();
      },
      consumeGateOverflow: () => gateBacklog.overflowed(),
      onResyncSettled: async (resynced) => {
        // 同步取出并补写：这段在 setResyncActive(false) 之后同一拍执行，新的实时
        // chunk 插不到它前面，字节顺序不乱。
        const { chunks, overflowed } = gateBacklog.take();
        const snapshot = lastRecoverySnapshot;
        // epoch "0" = 旧后端无 seq 记账，endSeq 不可用；恢复失败时画面没被快照替换。
        const floorSeq = resynced && snapshot && snapshot.checkpointEpoch !== "0" ? snapshot.endSeq : null;
        if (floorSeq !== null) reconciler.arm(floorSeq);
        // 旧后端恢复成功但没法对账：请求发出前暂存的片快照必然包含，丢弃；之后的保留。
        const candidates = resynced && floorSeq === null ? chunks.slice(chunksBeforeRequest) : chunks;
        chunksBeforeRequest = 0;
        const writes: Array<Promise<void>> = [];
        let written = 0;
        for (const candidate of candidates) {
          const ready = reconciler.active() ? reconciler.accept(candidate.data, candidate.endSeq) : [candidate];
          for (const chunk of ready) {
            written += 1;
            const write = deliverReconciled(chunk);
            if (write) writes.push(write);
          }
        }
        if (chunks.length > 0 || overflowed) {
          debugLog("output.gate.replay", {
            bindSessionId: sessionId,
            received: chunks.length,
            written,
            floorSeq,
            overflowed,
          });
        }
        // 等补写落屏再往下走：挂起的 exit 横幅必须排在最后一段输出之后。
        await Promise.all(writes);
        if (overflowed && resynced) {
          // 连续几轮都溢出（持续刷屏）：这一段输出确实缺了，明说，不装作完整。
          void writeTerminalData(RESYNC_FAILED_NOTICE).catch(() => {});
        }
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
          clearTerminalOutputDesyncLatch(sessionId);
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
    reconciler.disarm();
    gateBacklog.reset();
    hiddenQueryUnsub();
    // 可选调用：测试替身的 registerDesync/registerCheckpointRequest 可能不返回
    // unsubscribe（真实实现恒返回函数）。
    desyncUnsub?.();
    checkpointRequestUnsub?.();
  };
  overflowResyncRef.current = resyncHandler;
  // 副视图回放期间，新输出只发给了当时已订阅的主视图，这里既不在快照里也不会再来。
  // 会话此后一直安静的话，上面「下一帧不连续」的检测等不到触发，所以绑定完就查一次：
  // 会话已分发的进度超过了本视图快照覆盖到的位置，就是漏了。主视图不查——它订阅前的
  // 输出进了待补投队列，会完整送到。
  if (attachFloorSeq !== null && !ownsSeqLedger()) {
    const received = receivedThroughSeq(sessionId);
    if (received !== null && received > attachFloorSeq) {
      resyncForGap("missed-during-replay", attachFloorSeq, received);
    }
  }
  debugLog("session.bind-callbacks.end", { bindSessionId: sessionId });
}
