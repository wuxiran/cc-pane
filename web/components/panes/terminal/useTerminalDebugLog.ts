// dev 侧 terminal-debug 事件日志。从 TerminalView.tsx 拆出（纯代码移动，逻辑不变）。
import { useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import { devDebugLog } from "@/utils/devLogger";
import type { TerminalRendererController } from "../terminalRendererController";
import type { CliTool } from "@/types";

const TERMINAL_DEBUG = import.meta.env.DEV;

interface RefValue<T> {
  current: T;
}

export interface UseTerminalDebugLogParams {
  paneId?: string;
  tabId?: string;
  projectPath: string;
  sessionId: string | null;
  layoutActive?: boolean;
  effectiveCliTool: CliTool;
  debugInstanceIdRef: RefValue<string>;
  currentSessionIdRef: RefValue<string | null>;
  rendererControllerRef: RefValue<TerminalRendererController | null>;
  terminalInstanceRef: RefValue<Terminal | null>;
}

export function useTerminalDebugLog({
  paneId,
  tabId,
  projectPath,
  sessionId,
  layoutActive,
  effectiveCliTool,
  debugInstanceIdRef,
  currentSessionIdRef,
  rendererControllerRef,
  terminalInstanceRef,
}: UseTerminalDebugLogParams) {
  return useCallback((event: string, payload: Record<string, unknown> = {}) => {
    if (!TERMINAL_DEBUG) return;
    devDebugLog("terminal-debug", event, {
      instanceId: debugInstanceIdRef.current,
      paneId: paneId ?? null,
      tabId: tabId ?? null,
      projectPath,
      propSessionId: sessionId ?? null,
      sessionId: currentSessionIdRef.current ?? sessionId ?? null,
      cliTool: effectiveCliTool,
      layoutActive: layoutActive ?? true,
      renderer: rendererControllerRef.current?.getActiveRenderer() ?? null,
      xtermBuffer: terminalInstanceRef.current?.buffer.active.type ?? null,
      ...payload,
    });
  }, [
    effectiveCliTool,
    layoutActive,
    paneId,
    projectPath,
    sessionId,
    tabId,
  ]);
}
