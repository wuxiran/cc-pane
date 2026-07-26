import type { CreateSessionRequest } from "@/types";
import { devDebugLog } from "@/utils/devLogger";

export interface TerminalReplaySnapshot {
  data: string;
  bufferMode: "normal" | "alternate";
}

export type TerminalWriteSource = "user-keyboard" | "mcp" | "system";

export interface TerminalBackendClientInfo {
  mode: "in-process" | "daemon";
  /** daemon 模式下的桌面客户端数；缺失 = 旧 daemon（调用方应 fail-closed） */
  desktopClientCount?: number;
  claimsSupported?: boolean;
  daemonGeneration?: number;
  instanceId?: string;
}

export interface TerminalWriteOptions {
  source?: TerminalWriteSource;
  traceId?: number;
}

export function summarizeTerminalInput(data: string): Record<string, unknown> {
  const chars = Array.from(data);
  return {
    text: chars.length > 24 ? `${chars.slice(0, 24).join("")}...` : data,
    length: chars.length,
    utf16Length: data.length,
    codePoints: chars.slice(0, 24).map((char) => char.codePointAt(0)?.toString(16) ?? ""),
    truncated: chars.length > 24,
  };
}

const TERMINAL_SERVICE_DEBUG = import.meta.env.DEV;

export function debugTerminalService(
  event: string,
  payload: Record<string, unknown>,
): void {
  if (!TERMINAL_SERVICE_DEBUG) return;
  devDebugLog("terminal-service-debug", event, payload);
}

export function countTerminalInputChars(data: string): number {
  const withoutAnsi = data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  let count = 0;
  for (const char of withoutAnsi) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\t" || (code >= 0x20 && code !== 0x7f)) {
      count += 1;
    }
  }
  return count;
}

export function assertCreateSessionRequest(
  request: CreateSessionRequest | null | undefined,
): asserts request is CreateSessionRequest {
  if (!request || typeof request !== "object") {
    throw new Error("create_terminal_session requires a non-null request");
  }
}

export function compactCreateSessionRequest(
  request: CreateSessionRequest,
): CreateSessionRequest {
  return Object.fromEntries(
    Object.entries(request).filter(([, value]) => value !== null && value !== undefined),
  ) as CreateSessionRequest;
}

export function addSubscriber<T>(
  map: Map<string, Set<T>>,
  sessionId: string,
  callback: T,
): void {
  let set = map.get(sessionId);
  if (!set) {
    set = new Set();
    map.set(sessionId, set);
  }
  set.add(callback);
}

export function removeSubscriber<T>(
  map: Map<string, Set<T>>,
  sessionId: string,
  callback: T,
): void {
  const set = map.get(sessionId);
  if (!set) return;
  set.delete(callback);
  if (set.size === 0) map.delete(sessionId);
}
