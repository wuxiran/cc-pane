import type { Terminal } from "@xterm/xterm";

import { getErrorMessage } from "@/utils";
import { detectAlternateBufferTransitions } from "./terminalBufferMode";
import { detectFocusReportMode } from "./terminalFocusReport";
import {
  createTerminalHiddenWriteBuffer,
  type TerminalHiddenWriteBuffer,
} from "./terminalHiddenWriteBuffer";

interface RefValue<T> {
  current: T;
}

export interface CreateTerminalOutputHandlerOptions {
  /** 事件源会话 id，只用于日志归因。 */
  sessionId: string;
  terminalRef: RefValue<Terminal | null>;
  focusReportModeRef: RefValue<boolean>;
  hiddenWriteBufferRef: RefValue<TerminalHiddenWriteBuffer | null>;
  /** 本终端当前是否值得渲染（可见 且 所在布局是当前布局）。 */
  isRenderVisible: () => boolean;
  /** 当前 CLI 是否剥离 alt-screen，只用于日志归因。 */
  keepCliOutputInNormalBuffer: boolean;
  /** alt-screen 剥离等写入前的数据变换。 */
  renderTerminalData: (data: string) => string;
  writeTerminalData: (data: string, onWritten?: () => void) => Promise<void>;
  syncTrackedBufferType: (reason: string) => void;
  debugLog: (event: string, payload?: Record<string, unknown>) => void;
}

/**
 * PTY 输出 → xterm 的写入管线。
 *
 * 从 TerminalView 抽出（该文件已触到行数棘轮上限，见 web/test/lineRatchet.test.ts）。
 * 判据：只依赖显式传入的 ref 与回调，不碰组件内 state。
 *
 * 这里唯一的非平凡行为是**后台标签页积压**：非活动 tab 只是 `display: none` 仍保持挂载，
 * 照单全收会让 N 个后台会话各压一份 parser + renderer 上主线程（docs/71 §3、docs/73 §4）。
 * 策略是合并而非丢弃——不可见期间攒着，切回可见时一次性写入，零丢失、保序。
 */
export function createTerminalOutputHandler({
  sessionId,
  terminalRef,
  focusReportModeRef,
  hiddenWriteBufferRef,
  isRenderVisible,
  keepCliOutputInNormalBuffer,
  renderTerminalData,
  writeTerminalData,
  syncTrackedBufferType,
  debugLog,
}: CreateTerminalOutputHandlerOptions): (data: string) => void {
  return (data: string) => {
    const term = terminalRef.current;
    const focusReportMode = detectFocusReportMode(data, focusReportModeRef.current);
    if (focusReportMode !== focusReportModeRef.current) {
      debugLog("output.focus-report-mode.changed", {
        bindSessionId: sessionId,
        enabled: focusReportMode,
      });
      focusReportModeRef.current = focusReportMode;
    }

    const transitions = detectAlternateBufferTransitions(data);
    const renderedData = renderTerminalData(data);
    if (transitions.length > 0) {
      debugLog("output.alternate-sequence.received", {
        bindSessionId: sessionId,
        transitions,
        dataLength: data.length,
        renderedDataLength: renderedData.length,
        stripped: keepCliOutputInNormalBuffer,
      });
    }

    if (!term) {
      debugLog("output.write.skipped", {
        bindSessionId: sessionId,
        dataLength: data.length,
        transitions,
      });
      return;
    }

    if (!renderedData) {
      syncTrackedBufferType(
        transitions.length > 0 ? "output.alternate-sequence.stripped" : "output.empty",
      );
      return;
    }

    hiddenWriteBufferRef.current ??= createTerminalHiddenWriteBuffer({
      isVisible: isRenderVisible,
      onOverflowFlush: (length) => {
        debugLog("output.hidden.overflow-flush", { bindSessionId: sessionId, length });
      },
    });
    const writableData = hiddenWriteBufferRef.current.push(renderedData);
    if (writableData === null) return;

    void writeTerminalData(writableData, () => {
      if (transitions.length > 0) {
        debugLog("output.alternate-sequence.applied", {
          bindSessionId: sessionId,
          transitions,
          bufferAfter: term.buffer.active.type,
          stripped: keepCliOutputInNormalBuffer,
        });
      }
      syncTrackedBufferType(
        transitions.length > 0 ? "output.alternate-sequence" : "output.write",
      );
    }).catch((error) => {
      debugLog("output.write.failed", {
        bindSessionId: sessionId,
        dataLength: data.length,
        error: getErrorMessage(error),
      });
    });
  };
}
