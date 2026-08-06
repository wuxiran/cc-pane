import type { Terminal } from "@xterm/xterm";

import { getErrorMessage } from "@/utils";
import { detectAlternateBufferTransitions } from "./terminalBufferMode";
import { detectFocusReportMode } from "./terminalFocusReport";
import {
  createTerminalHiddenWriteBuffer,
  type TerminalHiddenWriteBuffer,
} from "./terminalHiddenWriteBuffer";
import { invalidateSeq, noteWritten } from "./terminalOutputSeqTracker";

interface RefValue<T> {
  current: T;
}

export interface CreateTerminalOutputHandlerOptions {
  /** 事件源会话 id：日志归因 + seq 记账（noteWritten/invalidate）的键。 */
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

interface FlushHiddenOutputBeforeExitOptions {
  term: Pick<Terminal, "writeln">;
  exitCode: number;
  hiddenWriteBuffer: TerminalHiddenWriteBuffer | null;
  writeTerminalData: (data: string, onWritten?: () => void) => Promise<void>;
  syncTrackedBufferType: (reason: string) => void;
  showReconnectHint: boolean;
  onSessionExited: () => void;
  onError: (error: unknown) => void;
}

/** Preserve PTY byte order even when the exit event arrives while the view is hidden. */
export function flushHiddenOutputBeforeExit({
  term,
  exitCode,
  hiddenWriteBuffer,
  writeTerminalData,
  syncTrackedBufferType,
  showReconnectHint,
  onSessionExited,
  onError,
}: FlushHiddenOutputBeforeExitOptions): void {
  const announceExit = () => {
    term.writeln(`\r\n\x1b[33mProcess exited with code ${exitCode}\x1b[0m`);
    if (showReconnectHint) {
      term.writeln("\x1b[36m[Disconnected] Press Enter to reconnect, or Ctrl+C to close.\x1b[0m");
    }
    onSessionExited();
  };
  const pending = hiddenWriteBuffer?.drain();
  if (!pending) {
    announceExit();
    return;
  }
  void writeTerminalData(pending, () => syncTrackedBufferType("output.hidden.exit-flush")).then(
    announceExit,
    (error) => {
      onError(error);
      announceExit();
    },
  );
}

/**
 * PTY 输出 → xterm 的写入管线。
 *
 * 从 TerminalView 抽出（该文件已触到行数棘轮上限，见 web/test/lineRatchet.test.ts）。
 * 判据：只依赖显式传入的 ref 与回调，不碰组件内 state。
 *
 * 这里唯一的非平凡行为是**后台标签页积压**：非活动 tab 只是 `display: none` 仍保持挂载，
 * 照单全收会让 N 个后台会话各压一份 parser + renderer 上主线程（docs/71 §3、docs/73 §4）。
 * 缓冲有硬上限；超过后停止接收隐藏输出并在恢复时提示截断，避免把积压转移到
 * Promise/xterm 内部队列后继续无界增长。
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
}: CreateTerminalOutputHandlerOptions): (data: string, endSeq?: number) => void {
  return (data: string, endSeq?: number) => {
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
      // 数据被丢弃（xterm 不在）：锚点连续性破坏，禁拍直到统一恢复 reanchor。
      if (endSeq !== undefined) invalidateSeq(sessionId);
      return;
    }

    if (!renderedData) {
      // 整段被剥掉（如 alt-screen 序列）：该 chunk 的渲染效果就是"空"，
      // 视同写完——否则最后一个 chunk 恰好为空时 in-flight 永不闭合、恒禁拍。
      if (endSeq !== undefined) noteWritten(sessionId, endSeq);
      syncTrackedBufferType(
        transitions.length > 0 ? "output.alternate-sequence.stripped" : "output.empty",
      );
      return;
    }

    hiddenWriteBufferRef.current ??= createTerminalHiddenWriteBuffer({
      isVisible: isRenderVisible,
      onOverflowDrop: (length) => {
        debugLog("output.hidden.truncated", { bindSessionId: sessionId, length });
      },
    });
    const writableData = hiddenWriteBufferRef.current.push(renderedData);
    if (writableData === null) {
      // 保守禁拍（M3b-2 设计裁决）：chunk 进了隐藏积压后，flush 是拼接整段
      // 补投（drain 合并），无法把 onWritten 逐 chunk 归属回 endSeq；溢出更是
      // 整段缺口。进入积压即 invalidate，直到统一恢复路径 reanchor（M3b-3）。
      invalidateSeq(sessionId);
      return;
    }

    void writeTerminalData(writableData, () => {
      if (endSeq !== undefined) noteWritten(sessionId, endSeq);
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
      // 写入失败 = 该 chunk 未必落屏：锚点连续性存疑，禁拍。
      if (endSeq !== undefined) invalidateSeq(sessionId);
      debugLog("output.write.failed", {
        bindSessionId: sessionId,
        dataLength: data.length,
        error: getErrorMessage(error),
      });
    });
  };
}
