// xterm parser 应答处理器装配（CPR / DA / Kitty keyboard / OSC 颜色查询）。
// 从 TerminalView.tsx 拆出（纯代码移动，逻辑不变）：init 闭包里按 term 注册，
// 返回的 disposables 由调用方放进 parserDisposableRefs 统一销毁。
import type { IDisposable, Terminal } from "@xterm/xterm";
import { useSettingsStore, useThemeStore } from "@/stores";
import { terminalService } from "@/services";
import { buildCursorPositionReport } from "../terminalCpr";
import {
  buildKittyKeyboardProtocolReport,
  buildPrimaryDeviceAttributesReport,
} from "../terminalCapabilityReports";
import { resolveOscColorQuery } from "../terminalOscColor";
import { getTerminalTheme } from "../terminalTheme";
import { writeTerminalReply } from "../terminalViewHelpers";
import type { CliTool } from "@/types";

interface RefValue<T> {
  current: T;
}

export interface TerminalParserHandlersDeps {
  term: Terminal;
  currentSessionIdRef: RefValue<string | null>;
  transparentCliSurfaceRef: RefValue<boolean>;
  effectiveCliToolRef: RefValue<CliTool>;
  debugLog: (event: string, payload?: Record<string, unknown>) => void;
}

/** Register CSI/OSC response handlers on the terminal parser. */
export function registerTerminalParserHandlers({
  term,
  currentSessionIdRef,
  transparentCliSurfaceRef,
  effectiveCliToolRef,
  debugLog,
}: TerminalParserHandlersDeps): IDisposable[] {
  const handleCursorPositionReport = (prefix?: string) => (params: (number | number[])[]) => {
    const sessionId = currentSessionIdRef.current;
    if (!sessionId) return false;
    const response = buildCursorPositionReport(
      params,
      prefix,
      term.buffer.active.cursorX,
      term.buffer.active.cursorY,
    );
    if (!response) return false;

    debugLog("terminal.cpr.reply", {
      sessionId,
      prefix: prefix ?? "",
      params,
      response,
    });
    void terminalService.write(sessionId, response, { source: "system" }).catch((error) => {
      console.warn("[TerminalView] Failed to send CPR response:", error);
    });
    return true;
  };
  const handleOscColorQuery = (ident: number) => (data: string) => {
    const sessionId = currentSessionIdRef.current;
    const result = resolveOscColorQuery(
      ident,
      data,
      getTerminalTheme(
        useThemeStore.getState().isDark,
        useSettingsStore.getState().settings?.terminal.themeMode,
      ),
      {
        preserveTransparentBackground: transparentCliSurfaceRef.current,
      },
    );
    debugLog("terminal.osc.query", {
      sessionId,
      ident,
      data,
      handled: result.handled,
      suppressed: result.handled && result.response === null,
    });
    if (!result.handled) return false;
    if (!result.response) {
      debugLog("terminal.osc.suppressed", {
        sessionId,
        ident,
        data,
        cliTool: effectiveCliToolRef.current,
      });
      return true;
    }

    writeTerminalReply(sessionId, result.response, (error) => {
      console.warn("[TerminalView] Failed to send OSC color response:", error);
    });
    debugLog("terminal.osc.reply", {
      sessionId,
      ident,
      data,
      response: result.response,
    });
    return true;
  };
  const handlePrimaryDeviceAttributesReport = (prefix?: string) => (params: (number | number[])[]) => {
    const sessionId = currentSessionIdRef.current;
    const response = buildPrimaryDeviceAttributesReport(params, prefix);
    debugLog("terminal.da.query", {
      sessionId,
      prefix: prefix ?? "",
      params,
      handled: Boolean(response),
    });
    if (!response) return false;

    writeTerminalReply(sessionId, response, (error) => {
      console.warn("[TerminalView] Failed to send DA response:", error);
    });
    return true;
  };
  const handleKittyKeyboardProtocolQuery = (prefix?: string) => (params: (number | number[])[]) => {
    const sessionId = currentSessionIdRef.current;
    const response = buildKittyKeyboardProtocolReport(params, prefix);
    debugLog("terminal.kitty-keyboard.query", {
      sessionId,
      prefix: prefix ?? "",
      params,
      handled: Boolean(response),
    });
    if (!response) return false;

    writeTerminalReply(sessionId, response, (error) => {
      console.warn("[TerminalView] Failed to send Kitty keyboard protocol response:", error);
    });
    return true;
  };
  return [
    term.parser.registerCsiHandler({ final: "n" }, handleCursorPositionReport()),
    term.parser.registerCsiHandler({ prefix: "?", final: "n" }, handleCursorPositionReport("?")),
    term.parser.registerCsiHandler({ final: "c" }, handlePrimaryDeviceAttributesReport()),
    term.parser.registerCsiHandler({ prefix: "?", final: "u" }, handleKittyKeyboardProtocolQuery("?")),
    term.parser.registerOscHandler(4, handleOscColorQuery(4)),
    term.parser.registerOscHandler(10, handleOscColorQuery(10)),
    term.parser.registerOscHandler(11, handleOscColorQuery(11)),
  ];
}
