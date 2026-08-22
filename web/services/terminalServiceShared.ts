import type { CreateSessionRequest } from "@/types";
import { clearSeqTracker } from "@/components/panes/terminalOutputSeqTracker";
import { disposeSessionScopedResources } from "@/lib/tabLifecycle/sessionScopedResources";
import { asPtySessionId } from "@/types/ids";
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
  /**
   * 这段输入的来源。必须逐条记而不是整队记：合批会把同一窗口内的多条拼成一个字符串，
   * 若把用户按键和前端代答的查询回复混进同一次写入，后端就无从分辨——而两者该受的
   * 待遇相反（回显开着时按键**应该**回显，代答回复则必须抑制）。
   */
  source: TerminalWriteSource;
  traceId?: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/**
 * 把一批待写输入切成**连续同源段**。顺序一字不变，只是不把用户按键和前端代答的
 * 查询回复揉进同一次写入——后端要靠来源决定回显开着时该不该抑制，混批等于把这个
 * 信息抹掉。同源的连续多段仍然合并，批处理的收益不受影响。
 */
export function splitInputRunsBySource(
  batch: QueuedTerminalInput[],
): Array<{ source: TerminalWriteSource; items: QueuedTerminalInput[] }> {
  const runs: Array<{ source: TerminalWriteSource; items: QueuedTerminalInput[] }> = [];
  for (const item of batch) {
    const tail = runs[runs.length - 1];
    if (tail && tail.source === item.source) tail.items.push(item);
    else runs.push({ source: item.source, items: [item] });
  }
  return runs;
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

export interface ParsedWebSocketOutput {
  data: string;
  /** 本批数据最后一个 raw chunk 的 seq（M3b-2）。旧 daemon / 非 output 帧无。 */
  endSeq?: number;
}

export function parseWebSocketOutput(message: unknown): ParsedWebSocketOutput {
  if (typeof message !== "string") return { data: "" };
  try {
    const parsed = JSON.parse(message) as { type?: string; data?: unknown; endSeq?: unknown };
    if (parsed.type === "output" && typeof parsed.data === "string") {
      return typeof parsed.endSeq === "number"
        ? { data: parsed.data, endSeq: parsed.endSeq }
        : { data: parsed.data };
    }
    // 其他结构化消息（exit/killed/未来类型）不是终端输出，不能注入 xterm
    if (typeof parsed.type === "string") {
      return { data: "" };
    }
  } catch {
    return { data: message };
  }
  return { data: message };
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

/** 会话已死：回收所有已登记的 per-session 前端资源。 */
export function disposeTerminalSessionResources(sessionId: string): void {
  // seq 记账是会话键卫星态（M3b-2）：会话死了锚点必须一并清，否则重建同名
  // 会话会带着旧 seq 记账拍出错配照片。
  clearSeqTracker(sessionId);
  disposeSessionScopedResources(asPtySessionId(sessionId));
}
