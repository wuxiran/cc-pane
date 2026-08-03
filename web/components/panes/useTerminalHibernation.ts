import { useCallback, useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { SerializeAddon } from "@xterm/addon-serialize";

import { getErrorMessage } from "@/utils";
import { terminalService } from "@/services/terminalService";
import type { TerminalReplaySnapshot } from "@/services/terminalService";
import { replayAttachedSession } from "./terminalReplay";
import {
  createTerminalBackgroundLifecycle,
  type TerminalBackgroundLifecycle,
} from "./terminalBackgroundLifecycle";
import {
  createHibernatedTerminalState,
  type HibernatedTerminalState,
} from "./terminalHibernation";
import type { TerminalHiddenWriteBuffer } from "./terminalHiddenWriteBuffer";
import type { TerminalRendererController } from "./terminalRendererController";

interface RefValue<T> {
  current: T;
}
type HibernationLogger = (event: string, payload?: Record<string, unknown>) => void;

interface UseTerminalHibernationOptions {
  terminalInstanceRef: RefValue<Terminal | null>;
  currentSessionIdRef: RefValue<string | null>;
  serializeAddonRef: RefValue<SerializeAddon | null>;
  hiddenWriteBufferRef: RefValue<TerminalHiddenWriteBuffer | null>;
  rendererControllerRef: RefValue<TerminalRendererController | null>;
  isReconnectingRef: RefValue<boolean>;
  isDisconnectedRef: RefValue<boolean>;
  debugLog: HibernationLogger;
  /** epoch 自增：触发 TerminalView 的 init effect 整轮 teardown + 重建。 */
  bumpInstanceEpoch: () => void;
}

export interface TerminalHibernationHandle {
  /** 休眠中（init effect 应走轻量分支）。 */
  hibernatedStateRef: RefValue<HibernatedTerminalState | null>;
  /** 唤醒交接（init attach 分支优先回放它）。 */
  wakeStateRef: RefValue<HibernatedTerminalState | null>;
  /** 每次 render 汇报可见性（幂等），驱动 5min/30min 两档降档定时器。 */
  notifyVisibility: (visible: boolean) => void;
}

/**
 * 后台标签分层降档（docs/71 §3.1）：5min 挂 WebGL，30min 休眠。
 *
 * Tier2 休眠：serialize 全量缓冲 → 交接给 hibernatedStateRef → epoch 自增。
 * 旧 init effect 的 cleanup 完整销毁 xterm/renderer/订阅；新一轮 effect 见到
 * hibernatedStateRef 走轻量分支（只收集输出，不构造实例）。
 * 唤醒：休眠数据移交 wakeStateRef，epoch 自增让 init 全量重建并回放。
 */
export function useTerminalHibernation({
  terminalInstanceRef,
  currentSessionIdRef,
  serializeAddonRef,
  hiddenWriteBufferRef,
  rendererControllerRef,
  isReconnectingRef,
  isDisconnectedRef,
  debugLog,
  bumpInstanceEpoch,
}: UseTerminalHibernationOptions): TerminalHibernationHandle {
  const hibernatedStateRef = useRef<HibernatedTerminalState | null>(null);
  const wakeStateRef = useRef<HibernatedTerminalState | null>(null);
  const backgroundLifecycleRef = useRef<TerminalBackgroundLifecycle | null>(null);

  const hibernateNow = useCallback(() => {
    const term = terminalInstanceRef.current;
    const sessionId = currentSessionIdRef.current;
    const serialize = serializeAddonRef.current;
    if (!term || !sessionId || !serialize || hibernatedStateRef.current) return;
    // 重连中 / 已断开的 SSH 视图不休眠：doReconnect 持有 term 引用，销毁会竞态。
    if (isReconnectingRef.current || isDisconnectedRef.current) return;

    let base: string;
    try {
      base = serialize.serialize();
    } catch (error) {
      debugLog("hibernate.serialize.failed", { error: getErrorMessage(error) });
      return;
    }
    // 休眠时点的积压排在 serialize 产物之后（都是成品 VT 流，直接拼接保序）。
    const backlog = hiddenWriteBufferRef.current?.drain();
    if (backlog) base += backlog;

    hibernatedStateRef.current = createHibernatedTerminalState({
      sessionId,
      base,
      onOverflow: () => {
        debugLog("hibernate.overflow", { hibernateSessionId: sessionId });
      },
    });
    debugLog("hibernate.begin", {
      hibernateSessionId: sessionId,
      baseChars: base.length,
    });
    bumpInstanceEpoch();
  }, [
    bumpInstanceEpoch,
    currentSessionIdRef,
    debugLog,
    hiddenWriteBufferRef,
    isDisconnectedRef,
    isReconnectingRef,
    serializeAddonRef,
    terminalInstanceRef,
  ]);

  const wakeFromHibernation = useCallback(() => {
    const hibernated = hibernatedStateRef.current;
    if (!hibernated) return;
    hibernatedStateRef.current = null;
    wakeStateRef.current = hibernated;
    debugLog("hibernate.wake", {
      wakeSessionId: hibernated.sessionId,
      pendingChars: hibernated.pendingChars(),
      overflowed: hibernated.didOverflow(),
    });
    bumpInstanceEpoch();
  }, [bumpInstanceEpoch, debugLog]);

  const hibernateNowRef = useRef(hibernateNow);
  const wakeFromHibernationRef = useRef(wakeFromHibernation);
  hibernateNowRef.current = hibernateNow;
  wakeFromHibernationRef.current = wakeFromHibernation;

  const notifyVisibility = useCallback(
    (visible: boolean) => {
      // 回调走 ref 蹦床：本函数在每次 render 被调用，notifyVisibility 幂等。
      backgroundLifecycleRef.current ??= createTerminalBackgroundLifecycle({
        onTier1: () => rendererControllerRef.current?.suspendWebgl("background"),
        onTier1Restore: () => rendererControllerRef.current?.resumeWebgl("foreground"),
        onTier2: () => hibernateNowRef.current(),
        onTier2Restore: () => wakeFromHibernationRef.current(),
      });
      backgroundLifecycleRef.current.notifyVisibility(visible);
    },
    [rendererControllerRef],
  );

  // 组件级定时器随卸载销毁（React 19 dev 双挂载下重建无害：notifyVisibility 幂等）。
  useEffect(() => {
    return () => {
      backgroundLifecycleRef.current?.dispose();
      backgroundLifecycleRef.current = null;
      hibernatedStateRef.current = null;
      wakeStateRef.current = null;
    };
  }, []);

  return { hibernatedStateRef, wakeStateRef, notifyVisibility };
}

interface CollectHibernatedOutputOptions {
  hibernated: HibernatedTerminalState;
  renderTerminalData: (data: string) => string;
  /** 休眠期间维持会话归属（focus/imperative API 判定用），清理时置空。 */
  currentSessionIdRef: RefValue<string | null>;
  isSshRef: RefValue<boolean>;
  onReconnectRef: RefValue<(() => Promise<string | null>) | null | undefined>;
  /** SSH 且可重连的视图退出时置真（与前台退出路径口径一致），唤醒后重连链路才接得上。 */
  isDisconnectedRef: RefValue<boolean>;
  onSessionExited: (exitCode: number) => void;
}

/**
 * 休眠态的轻量会话订阅：不构造 xterm，把输出（经 renderTerminalData 渲染后）
 * 收进休眠容器（保序、有上限），退出记录到容器并回调上层。
 * desync 也必须订阅——休眠期间镜像流跳段的话容器已带缺口，作废改走 snapshot。
 * 返回清理函数。
 */
export function collectHibernatedOutput({
  hibernated,
  renderTerminalData,
  currentSessionIdRef,
  isSshRef,
  onReconnectRef,
  isDisconnectedRef,
  onSessionExited,
}: CollectHibernatedOutputOptions): () => void {
  currentSessionIdRef.current = hibernated.sessionId;
  let cancelled = false;
  const unsubs: Array<() => void> = [];
  const track = (registration: Promise<() => void>) => {
    void registration.then((unsub) => {
      if (cancelled) unsub();
      else unsubs.push(unsub);
    });
  };
  track(
    terminalService.registerOutput(hibernated.sessionId, (data) => {
      const rendered = renderTerminalData(data);
      if (rendered) hibernated.appendRendered(rendered);
    }),
  );
  track(
    terminalService.registerExit(hibernated.sessionId, (exitCode) => {
      hibernated.recordExit(exitCode);
      if (isSshRef.current && onReconnectRef.current) {
        isDisconnectedRef.current = true;
      }
      onSessionExited(exitCode);
    }),
  );
  track(
    terminalService.registerDesync(hibernated.sessionId, () => {
      hibernated.markDesynced();
    }),
  );
  return () => {
    cancelled = true;
    for (const unsub of unsubs) unsub();
    unsubs.length = 0;
    currentSessionIdRef.current = null;
  };
}

interface ReplayHibernationWakeOptions {
  wake: HibernatedTerminalState;
  term: Pick<Terminal, "writeln">;
  /** 已是成品 VT 流，不可二次渲染。 */
  writeTerminalData: (data: string) => Promise<void>;
  syncTrackedBufferType: (reason: string) => void;
  /** 休眠溢出/desync 时的兜底：走后端 replay snapshot。 */
  replayFromSnapshot: () => Promise<void>;
  /** SSH 且可重连的视图：退出横幅后补重连提示（与前台退出路径口径一致）。 */
  showReconnectHint: boolean;
  debugLog: HibernationLogger;
}

/**
 * 唤醒回放：休眠容器完整则直接回放（全量历史，超出后端 8MB 窗口也不丢）；
 * 溢出/desync 则走后端 snapshot。休眠期间会话已退出时补退出横幅
 * （onSessionExited 在休眠期已回调，不重复）。
 */
export async function replayHibernationWake({
  wake,
  term,
  writeTerminalData,
  syncTrackedBufferType,
  replayFromSnapshot,
  showReconnectHint,
  debugLog,
}: ReplayHibernationWakeOptions): Promise<void> {
  const wakeData = wake.wakeData();
  if (wakeData !== null) {
    if (wakeData) {
      await writeTerminalData(wakeData);
    }
    syncTrackedBufferType("hibernation.wake");
    debugLog("hibernate.wake.replayed", {
      wakeSessionId: wake.sessionId,
      dataLength: wakeData.length,
    });
  } else {
    await replayFromSnapshot();
  }
  const wakeExitCode = wake.exitCode();
  if (wakeExitCode !== null) {
    term.writeln(`\r\n\x1b[33mProcess exited with code ${wakeExitCode}\x1b[0m`);
    if (showReconnectHint) {
      term.writeln("\x1b[36m[Disconnected] Press Enter to reconnect, or Ctrl+C to close.\x1b[0m");
    }
  }
}

interface ReplayAttachOrWakeOptions {
  term: Terminal;
  sessionId: string;
  /** 休眠唤醒交接；普通 attach 传 null。 */
  wake: HibernatedTerminalState | null;
  getReplaySnapshot: (sessionId: string) => Promise<TerminalReplaySnapshot | null>;
  renderTerminalData: (data: string) => string;
  writeTerminalData: (data: string) => Promise<void>;
  syncTrackedBufferType: (reason: string) => void;
  showReconnectHint: boolean;
  debugLog: HibernationLogger;
}

/** attach 分支的回放选路：休眠容器优先，普通 attach / 溢出走后端 snapshot。 */
export async function replayAttachOrWake({
  term,
  sessionId,
  wake,
  getReplaySnapshot,
  renderTerminalData,
  writeTerminalData,
  syncTrackedBufferType,
  showReconnectHint,
  debugLog,
}: ReplayAttachOrWakeOptions): Promise<void> {
  const replayFromSnapshot = async () => {
    await replayAttachedSession({
      term,
      sessionId,
      getReplaySnapshot,
      writeData: (data) => {
        const renderedData = renderTerminalData(data);
        return renderedData ? writeTerminalData(renderedData) : Promise.resolve();
      },
      syncTrackedBufferType,
      debugLog,
    });
  };
  if (wake) {
    await replayHibernationWake({
      wake,
      term,
      writeTerminalData,
      syncTrackedBufferType,
      replayFromSnapshot,
      showReconnectHint,
      debugLog,
    });
  } else {
    await replayFromSnapshot();
  }
}
