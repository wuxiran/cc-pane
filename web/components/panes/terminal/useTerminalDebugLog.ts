// dev 侧 terminal-debug 事件日志。从 TerminalView.tsx 拆出（纯代码移动，逻辑不变）。
import { useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import { devDebugLog } from "@/utils/devLogger";
import { logInfoSafe } from "@/services/runtime";
import type { TerminalRendererController } from "../terminalRendererController";
import type { CliTool } from "@/types";

const TERMINAL_DEBUG = import.meta.env.DEV;

/**
 * 发布版也要落盘的事件：它们各自标记一种"画面停住"的成因或自愈动作。
 * 没有这些，正式版里的卡死只能靠后台性能采样反推（2026-10 实机排障的教训）。
 */
const RELEASE_DIAGNOSTIC_EVENT_PREFIXES = [
  "watchdog.",
  "renderer.changed",
  "renderer.webgl.",
  "webgl.",
  "resync.",
  "recovery.",
  "flow.stall",
  "session.adopt-live.failed",
];
/** 同一事件名的落盘最小间隔；自愈循环打转时不能把日志变成风暴源。 */
const RELEASE_DIAGNOSTIC_MIN_INTERVAL_MS = 5_000;
const releaseDiagnosticLastLoggedAt = new Map<string, number>();

export function isReleaseDiagnosticEvent(event: string): boolean {
  return RELEASE_DIAGNOSTIC_EVENT_PREFIXES.some((prefix) => event.startsWith(prefix));
}

/** 返回 true 表示本次应落盘（并记录时间）；限频按 `key` 维度。 */
export function shouldLogReleaseDiagnostic(
  key: string,
  now: number,
  minIntervalMs = RELEASE_DIAGNOSTIC_MIN_INTERVAL_MS,
): boolean {
  const last = releaseDiagnosticLastLoggedAt.get(key);
  if (last !== undefined && now - last < minIntervalMs) return false;
  releaseDiagnosticLastLoggedAt.set(key, now);
  return true;
}

function serializeDiagnosticPayload(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload, (_key, value) =>
      value instanceof Error ? { name: value.name, message: value.message } : value,
    );
  } catch {
    return "\"[unserializable-payload]\"";
  }
}

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
    if (!TERMINAL_DEBUG) {
      // 发布版：只放行诊断级事件，限频后写进 plugin-log（cc-panes.log）。
      if (!isReleaseDiagnosticEvent(event)) return;
      const sid = currentSessionIdRef.current ?? sessionId ?? null;
      if (!shouldLogReleaseDiagnostic(`${event}|${sid ?? debugInstanceIdRef.current}`, Date.now())) return;
      logInfoSafe(
        `[terminal-diag] ${event} ${serializeDiagnosticPayload({
          sessionId: sid,
          cliTool: effectiveCliTool,
          renderer: rendererControllerRef.current?.getActiveRenderer() ?? null,
          xtermBuffer: terminalInstanceRef.current?.buffer.active.type ?? null,
          ...payload,
        })}`,
      ).catch(() => {});
      return;
    }
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
