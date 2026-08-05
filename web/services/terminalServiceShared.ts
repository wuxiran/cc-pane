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

export interface QueuedTerminalInput {
  data: string;
  traceId?: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export interface TerminalInputQueue {
  pending: QueuedTerminalInput[];
  timer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
  idleResolvers: Array<() => void>;
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

/** WS 消息是否是 desync 标记（daemon 输出镜像流溢出跳段，见 desync 契约）。 */
export function isWebSocketDesyncMessage(message: unknown): boolean {
  if (typeof message !== "string" || !message.includes("desync")) return false;
  try {
    return (JSON.parse(message) as { type?: string }).type === "desync";
  } catch {
    return false;
  }
}

export function parseWebSocketOutput(message: unknown): string {
  if (typeof message !== "string") return "";
  try {
    const parsed = JSON.parse(message) as { type?: string; data?: unknown };
    if (parsed.type === "output" && typeof parsed.data === "string") {
      return parsed.data;
    }
    // 其他结构化消息（exit/killed/未来类型）不是终端输出，不能注入 xterm
    if (typeof parsed.type === "string") {
      return "";
    }
  } catch {
    return message;
  }
  return message;
}

/**
 * 判断一次写入失败是否因为该会话的写权限被**另一个 CC-Panes 实例**持有
 * （daemon 侧租约裁决，docs/61 阶段 2）。
 *
 * `SESSION_CLAIMED` 是我们两端自定义的协议码，不是人类可读文案，
 * daemon 改文案不会让这个判断失效。
 */
export function isSessionClaimedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("SESSION_CLAIMED");
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

/**
 * 会话已死：回收 per-session 上下文用量缓存条目。
 * 延迟 import 避免 store ↔ service 循环依赖。
 */
export function dropContextUsage(sessionId: string): void {
  void import("@/stores/useContextUsageStore")
    .then(({ useContextUsageStore }) => useContextUsageStore.getState().dropSession(sessionId));
}
