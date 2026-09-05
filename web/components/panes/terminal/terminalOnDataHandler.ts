// xterm onData 输入转发：trace、焦点报告过滤、SSH 断连回车重连、写入错误兜底。
// 从 TerminalView.tsx 拆出（纯代码移动，逻辑不变）。
import type { TFunction } from "i18next";
import { isSessionClaimedError, terminalService } from "@/services/terminalService";
import { isXtermFocusReportInput } from "../terminalFocusReport";
import type { attachTerminalDomInputFallback } from "../terminalDomInputFallback";
import type { attachTerminalInputTrace } from "../terminalInputTrace";
import { summarizeTerminalInputData } from "../terminalInputTrace";
import { notifySessionClaimed } from "../terminalSessionNotices";

interface RefValue<T> {
  current: T;
}

export interface TerminalOnDataHandlerDeps {
  debugLog: (event: string, payload?: Record<string, unknown>) => void;
  inputTraceSeqRef: RefValue<number>;
  domInputFallbackRef: RefValue<ReturnType<typeof attachTerminalDomInputFallback> | null>;
  inputTraceRef: RefValue<ReturnType<typeof attachTerminalInputTrace> | null>;
  focusReportModeRef: RefValue<boolean>;
  isDisconnectedRef: RefValue<boolean>;
  isReconnectingRef: RefValue<boolean>;
  currentSessionIdRef: RefValue<string | null>;
  readOnlyRef: RefValue<boolean>;
  doReconnect: () => void;
  t: TFunction<"panes">;
}

/** Forward terminal input, with Enter-to-reconnect handling for SSH disconnects. */
export function createTerminalOnDataHandler({
  debugLog,
  inputTraceSeqRef,
  domInputFallbackRef,
  inputTraceRef,
  focusReportModeRef,
  isDisconnectedRef,
  isReconnectingRef,
  currentSessionIdRef,
  readOnlyRef,
  doReconnect,
  t,
}: TerminalOnDataHandlerDeps): (data: string) => void {
  return (data: string) => {
    const traceId = ++inputTraceSeqRef.current;
    debugLog("input.xterm.onData", {
      traceId,
      data: summarizeTerminalInputData(data),
      disconnected: isDisconnectedRef.current,
      hasSession: Boolean(currentSessionIdRef.current),
      focusReportMode: focusReportModeRef.current,
    });
    domInputFallbackRef.current?.recordXtermData(data);
    inputTraceRef.current?.onData(data);
    if (isXtermFocusReportInput(data) && !focusReportModeRef.current) {
      debugLog("input.xterm.drop.focus-report", {
        traceId,
        data: summarizeTerminalInputData(data),
        reason: "focus-report-mode-disabled",
      });
      return;
    }
    // Only Enter should trigger reconnect while disconnected.
    if (isDisconnectedRef.current) {
      if (!isReconnectingRef.current && (data === "\r" || data === "\n")) {
        doReconnect();
      }
      return;
    }
    const sessionId = currentSessionIdRef.current;
    if (sessionId && !readOnlyRef.current) {
      // 写入失败必须让用户看见。会话被另一个实例持有时 daemon 会挡下输入，
      // 以前这里是 fire-and-forget，rejection 无人接管 = 打字石沉大海。
      terminalService.write(sessionId, data, { traceId }).catch((error) => {
        if (isSessionClaimedError(error)) {
          notifySessionClaimed(sessionId, t("sessionClaimedByOtherInstance"));
          return;
        }
        debugLog("input.write.error", {
          traceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } else {
      debugLog("input.xterm.drop.no-session", {
        traceId,
        data: summarizeTerminalInputData(data),
      });
    }
  };
}
