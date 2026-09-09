// 终端数据管线：渲染剥色、缓冲类型跟踪、重绘/重排、唯一写入出口、隐藏积压补投。
// 从 TerminalView.tsx 拆出（纯代码移动，逻辑不变）。
import { useCallback, useEffect, useMemo } from "react";
import { registerTerminalPerformanceSource } from "@/services/performanceMetrics";
import type { Terminal } from "@xterm/xterm";
import { captureTerminalWrite } from "@/utils/terminalCast";
import { getErrorMessage } from "@/utils";
import {
  createTerminalDataRenderer,
  stripSgrBackgroundColors,
  type TerminalDataRenderer,
} from "../terminalBufferMode";
import { detectFocusReportMode } from "../terminalFocusReport";
import type { TerminalHiddenWriteBuffer } from "../terminalHiddenWriteBuffer";
import { createHiddenWriteFlusher } from "../terminalSessionBinding";
import type { TerminalRendererController } from "../terminalRendererController";
import type { TerminalLayoutRequestOptions, TerminalLayoutScheduler } from "../terminalLayoutScheduler";
import type { createTerminalWriteFlowControl } from "../terminalWriteFlowControl";
import type { CliTool } from "@/types";

interface RefValue<T> {
  current: T;
}

export interface UseTerminalDataPipelineParams {
  sessionId: string | null;
  keepCliOutputInNormalBuffer: boolean;
  terminalInstanceRef: RefValue<Terminal | null>;
  rendererControllerRef: RefValue<TerminalRendererController | null>;
  layoutSchedulerRef: RefValue<TerminalLayoutScheduler | null>;
  currentSessionIdRef: RefValue<string | null>;
  terminalDataRendererRef: RefValue<TerminalDataRenderer | null>;
  effectiveCliToolProbeRef: RefValue<CliTool>;
  transparentCliSurfaceRef: RefValue<boolean>;
  trackedBufferTypeRef: RefValue<"unknown" | "normal" | "alternate">;
  focusReportModeRef: RefValue<boolean>;
  writeFlowControlRef: RefValue<ReturnType<typeof createTerminalWriteFlowControl> | null>;
  hiddenWriteBufferRef: RefValue<TerminalHiddenWriteBuffer | null>;
  resyncInProgressRef: RefValue<boolean>;
  overflowResyncRef: RefValue<(() => Promise<boolean>) | null>;
  debugLog: (event: string, payload?: Record<string, unknown>) => void;
}

export function useTerminalDataPipeline({
  sessionId,
  keepCliOutputInNormalBuffer,
  terminalInstanceRef,
  rendererControllerRef,
  layoutSchedulerRef,
  currentSessionIdRef,
  terminalDataRendererRef,
  effectiveCliToolProbeRef,
  transparentCliSurfaceRef,
  trackedBufferTypeRef,
  focusReportModeRef,
  writeFlowControlRef,
  hiddenWriteBufferRef,
  resyncInProgressRef,
  overflowResyncRef,
  debugLog,
}: UseTerminalDataPipelineParams) {
  useEffect(() => registerTerminalPerformanceSource(() => {
    const term = terminalInstanceRef.current;
    const flow = writeFlowControlRef.current;
    if (!term || !flow) return null;
    const stats = flow.getStats();
    const renderer = rendererControllerRef.current?.getDiagnostics();
    return { sessionId: currentSessionIdRef.current, visible: Boolean(term.element?.getClientRects().length),
      renderer: renderer?.activeRenderer ?? "unknown", queuedChars: stats.queuedChars, inFlightChars: stats.inFlightChars,
      queuedWrites: stats.queuedWrites, oldestWaitMs: Math.min(stats.oldestWaitMs, 86_400_000),
      receivedChars: stats.receivedChars, writeCalls: stats.writeCalls, failedWrites: stats.failedWrites,
      callbackMaxMs: Math.min(stats.callbackMaxMs, 86_400_000), hiddenChars: hiddenWriteBufferRef.current?.pendingLength() ?? 0,
      resyncActive: resyncInProgressRef.current, contextLosses: renderer?.contextLossCount ?? 0,
      atlasClears: renderer?.atlasClearCount ?? 0, scrollbackLines: term.buffer.active.length };
  }), [currentSessionIdRef, hiddenWriteBufferRef, rendererControllerRef, resyncInProgressRef, terminalInstanceRef, writeFlowControlRef]);
  const renderTerminalData = useCallback((data: string) => {
    terminalDataRendererRef.current ??= createTerminalDataRenderer({
      // 常规运行中观测跨 chunk 重组后的真实 1049 命中；事件仅在切换时产生。
      // 不走受 TERMINAL_DEBUG 门控的 debugLog。
      onStrippedTransition: (transition) => {
        console.info("[alt-screen-probe]", {
          cliTool: effectiveCliToolProbeRef.current,
          sessionId: currentSessionIdRef.current,
          ...transition,
        });
      },
    });
    return terminalDataRendererRef.current.render(data, {
      keepCliOutputInNormalBuffer,
      sessionId: currentSessionIdRef.current,
      stripBackgroundColors: transparentCliSurfaceRef.current,
    });
  }, [keepCliOutputInNormalBuffer]);
  // photo 成品 VT 只剥 SGR 背景色；二次剥 alt-screen 会破坏画面。
  const renderCheckpointData = useCallback((data: string) =>
    transparentCliSurfaceRef.current ? stripSgrBackgroundColors(data) : data, []);
  const syncTrackedBufferType = useCallback((reason: string) => {
    const current = terminalInstanceRef.current?.buffer.active.type;
    const next =
      current === "alternate" || current === "normal"
        ? current
        : "unknown";
    if (trackedBufferTypeRef.current === next) return;
    const previous = trackedBufferTypeRef.current;
    trackedBufferTypeRef.current = next;
    debugLog("buffer.changed", {
      reason,
      previousBuffer: previous,
      nextBuffer: next,
    });
  }, [debugLog]);

  const repaintTerminal = useCallback((reason: string) => {
    const term = terminalInstanceRef.current;
    if (!term) return;

    const renderer = rendererControllerRef.current;
    if (renderer) {
      renderer.repaint(reason);
      return;
    }

    requestAnimationFrame(() => {
      if (terminalInstanceRef.current !== term) return;
      try {
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch (error) {
        debugLog("renderer.repaint.refresh.fail", {
          reason,
          error: getErrorMessage(error),
        });
      }
    });
  }, [debugLog]);

  const refitAndRepaintTerminal = useCallback((
    reason: string,
    options: TerminalLayoutRequestOptions = {},
  ): Terminal | null => {
    return layoutSchedulerRef.current?.flush(reason, options) ?? null;
  }, []);

  const writeTerminalData = useCallback(async (data: string, onWritten?: () => void) => {
    const flowControl = writeFlowControlRef.current;
    if (!flowControl) {
      throw new Error("Terminal write flow control is not initialized");
    }
    const terminalData = transparentCliSurfaceRef.current ? stripSgrBackgroundColors(data) : data;
    focusReportModeRef.current = detectFocusReportMode(terminalData, focusReportModeRef.current); // 1004 跟踪必须挂唯一写入出口：回放/重同步/唤醒同样携带，漏检=恢复会话丢光标（与 xterm 内部状态同源）
    // WebGL 花屏诊断台录制钩子（未 arm 时为 no-op，见 utils/terminalCast）。
    captureTerminalWrite(currentSessionIdRef.current ?? sessionId ?? "unknown", terminalData);
    await flowControl.write(terminalData, onWritten);
  }, [sessionId]);

  const flushHiddenWrites = useMemo(
    () =>
      createHiddenWriteFlusher({
        hiddenWriteBufferRef,
        resyncActiveRef: resyncInProgressRef,
        overflowResyncRef,
        writeTerminalData,
        syncTrackedBufferType,
        debugLog,
      }),
    [debugLog, syncTrackedBufferType, writeTerminalData],
  );

  return {
    renderTerminalData,
    renderCheckpointData,
    syncTrackedBufferType,
    repaintTerminal,
    refitAndRepaintTerminal,
    writeTerminalData,
    flushHiddenWrites,
  };
}
