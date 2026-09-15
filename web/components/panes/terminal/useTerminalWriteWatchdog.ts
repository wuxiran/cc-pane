import { useEffect } from "react";
import type { Terminal } from "@xterm/xterm";
import type { TerminalHiddenWriteBuffer } from "../terminalHiddenWriteBuffer";
import type { createTerminalWriteFlowControl } from "../terminalWriteFlowControl";

interface RefValue<T> {
  current: T;
}

export interface UseTerminalWriteWatchdogParams {
  isRenderVisible: () => boolean;
  terminalInstanceRef: RefValue<Terminal | null>;
  hiddenWriteBufferRef: RefValue<TerminalHiddenWriteBuffer | null>;
  writeFlowControlRef: RefValue<ReturnType<typeof createTerminalWriteFlowControl> | null>;
  resyncInProgressRef: RefValue<boolean>;
  overflowResyncRef: RefValue<(() => Promise<boolean>) | null>;
  flushHiddenWrites: (reason: string) => Promise<unknown>;
  onRendererFailure: (error: Error) => void;
  debugLog: (event: string, payload?: Record<string, unknown>) => void;
  /** D 类检测锚点：本视图当前绑定会话与最近收到输出的时间戳。 */
  currentSessionIdRef?: RefValue<string | null>;
  lastOutputReceivedAtRef?: RefValue<number>;
  /** daemon 侧最近输出时间（epoch ms）；取不到返回 null。 */
  getDaemonLastOutputAt?: (sessionId: string) => Promise<number | null>;
  /** 重绑输出订阅（starvation 一级自愈）。 */
  rebindOutput?: () => Promise<unknown>;
}

const TICK_MS = 2_000;
/** 写队列里最老的块等回调超过这个值 = 回调链死了（xterm/渲染器卡住），pump 永久 blocked。 */
const STUCK_OLDEST_WAIT_MS = 15_000;
/** resync 闸门合上超过这个值未解开 = 恢复流程挂死，积压永远等不到 flush。 */
const RESYNC_STALL_MS = 30_000;
/** D 类窗口：daemon 在产输出而本视图零收到的判定时长。 */
const STARVE_CHECK_MS = 12_000;
/** 重绑后仍饿到这个时长 = 订阅层无救，强 resync 重放。 */
const STARVE_RESYNC_MS = 24_000;
/** 同一类自愈动作的最小间隔，防watchdog自己变成风暴源。 */
const RECOVERY_COOLDOWN_MS = 60_000;

/**
 * 终端写入链路自愈watchdog。
 *
 * 三类「画面冻住」都不抛错、只表现为静默停写，用户视角是「终端黑掉/输入没反应」：
 * A. 挂载竞态：首帧输出到达时可见性判定还是 false，数据进了隐藏积压；标签页
 *     born-visible 时此后没有 hidden→visible 边沿，flush 永不触发；
 * B. 流控卡死：xterm 写回调不再回来，pendingCallbacks 顶到高水位，pump 永久 blocked；
 * C. resync 挂死：闸门合上后恢复流程未 settle，flush 永远返回 "resync" 等待。
 * 每类都复用既有恢复原语（flush / 关闭旧 writer 并重建视图 / 重跑 resync）。
 */
export function useTerminalWriteWatchdog({
  isRenderVisible,
  terminalInstanceRef,
  hiddenWriteBufferRef,
  writeFlowControlRef,
  resyncInProgressRef,
  overflowResyncRef,
  flushHiddenWrites,
  onRendererFailure,
  debugLog,
  currentSessionIdRef,
  lastOutputReceivedAtRef,
  getDaemonLastOutputAt,
  rebindOutput,
}: UseTerminalWriteWatchdogParams): void {
  useEffect(() => {
    let resyncSince: number | null = null;
    let starvedSince: number | null = null;
    let rebindAttempted = false;
    const lastRecoveryAt: Record<string, number> = {};
    const cooledDown = (key: string, now: number): boolean => {
      if (now - (lastRecoveryAt[key] ?? 0) < RECOVERY_COOLDOWN_MS) return false;
      lastRecoveryAt[key] = now;
      return true;
    };
    // DOM 事实优先：可见性注册表可能在挂载竞态里撒谎（登记成 hidden 后再无
    // 边沿补正），元素有尺寸 + document 可见 = 用户真的在看这个 pane。
    const domVisible = (): boolean =>
      typeof document !== "undefined"
      && document.visibilityState === "visible"
      && Boolean(terminalInstanceRef.current?.element?.getClientRects().length);

    const timer = setInterval(() => {
      const now = Date.now();

      // A：可见却有积压 = 挂载竞态吞了首帧，补投。
      const buffer = hiddenWriteBufferRef.current;
      if (buffer && buffer.pendingLength() > 0 && !resyncInProgressRef.current
        && (isRenderVisible() || domVisible())) {
        if (cooledDown("pending-while-visible", now)) {
          debugLog("watchdog.pending-while-visible", {
            pending: buffer.pendingLength(),
            registryVisible: isRenderVisible(),
            domVisible: domVisible(),
          });
          void flushHiddenWrites("watchdog.pending-while-visible");
        }
        return;
      }

      // B：常规 3s 检测由 writer 自身负责；这里兜底销毁并请求视图恢复。
      // 不复活旧队列，避免迟到的 xterm 回调重新写入尾部数据。
      const flow = writeFlowControlRef.current;
      const stats = flow?.getStats();
      if (stats && stats.queuedWrites > 0 && stats.oldestWaitMs >= STUCK_OLDEST_WAIT_MS) {
        if (cooledDown("queue-stuck", now)) {
          debugLog("watchdog.write-queue-stuck", {
            queuedWrites: stats.queuedWrites,
            oldestWaitMs: stats.oldestWaitMs,
          });
          flow?.dispose("terminal write watchdog: parsing stalled");
          onRendererFailure(new Error("Terminal write queue stopped draining"));
          return;
        }
      }

      // C：resync 闸门挂死 = 解开闸门并重跑恢复，让积压有出口。
      if (resyncInProgressRef.current) {
        resyncSince ??= now;
        if (now - resyncSince >= RESYNC_STALL_MS && cooledDown("resync-stall", now)) {
          debugLog("watchdog.resync-stall", { stalledMs: now - resyncSince });
          resyncInProgressRef.current = false;
          resyncSince = null;
          void overflowResyncRef.current?.();
        }
      } else {
        resyncSince = null;
      }

      // D：输出饿死——daemon 近期有产出而本视图零收到（订阅死/闸门卡）。
      // 一级重绑输出订阅，二级强 resync 重放；daemon 静默（真空闲）不误伤。
      const sessionId = currentSessionIdRef?.current ?? null;
      const lastReceived = lastOutputReceivedAtRef?.current ?? 0;
      if (
        sessionId
        && lastOutputReceivedAtRef
        && getDaemonLastOutputAt
        && now - lastReceived >= STARVE_CHECK_MS
      ) {
        starvedSince ??= now;
        void (async () => {
          const daemonLast = await getDaemonLastOutputAt(sessionId).catch(() => null);
          if (daemonLast === null) return;
          if (daemonLast > lastReceived && now - daemonLast <= STARVE_CHECK_MS) {
            if (!rebindAttempted && rebindOutput) {
              rebindAttempted = true;
              debugLog("watchdog.output-starved.rebind", { sessionId, daemonLast, lastReceived });
              void rebindOutput().catch(() => undefined);
            } else if (now - (starvedSince ?? 0) >= STARVE_RESYNC_MS && cooledDown("output-starved-resync", now)) {
              debugLog("watchdog.output-starved.resync", { sessionId, daemonLast, lastReceived });
              starvedSince = null;
              rebindAttempted = false;
              void overflowResyncRef.current?.();
            }
          }
        })();
      } else {
        starvedSince = null;
        rebindAttempted = false;
      }
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [
    isRenderVisible,
    terminalInstanceRef,
    hiddenWriteBufferRef,
    writeFlowControlRef,
    resyncInProgressRef,
    overflowResyncRef,
    flushHiddenWrites,
    onRendererFailure,
    debugLog,
    currentSessionIdRef,
    lastOutputReceivedAtRef,
    getDaemonLastOutputAt,
    rebindOutput,
  ]);
}
