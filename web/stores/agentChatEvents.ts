// ACP chat 事件桥：全局单例监听 + chunk 合批，把 Tauri 事件翻译成 useAgentChatStore 的动作。
//
// 高频 token 流不直接进 store：`agent_message_chunk` 接近逐 token 到达，每条
// 都走 Immer set() 就是渲染风暴（xterm 输出洪水的同族问题）。相邻同类、同归属
// 的 chunk 合批 16ms 再 flush，非 chunk 事件先排空缓冲保序。
// 从 useAgentChatStore 拆出（行数棘轮）：store 只管状态形状，这里只管事件到动作的翻译。
import { agentChatService } from "@/services/agentChatService";
import i18n from "@/i18n";
import { handleErrorSilent } from "@/utils/errorHandler";
import type {
  AcpChatEvent,
  AcpChatSnapshot,
  AcpPermissionRequest,
  AcpSessionUpdate,
  AcpTerminalOutput,
} from "@/types/agentChat";
import { parentToolCallIdOf } from "@/types/agentChat";
import { contentText, useAgentChatStore } from "./useAgentChatStore";

const FLUSH_INTERVAL_MS = 16;

interface ChunkBuffer {
  kind: "assistant" | "thought";
  text: string;
  /** 子 agent 归属；主/子 agent 的流交错时换缓冲，防止拼进同一气泡。 */
  parentToolCallId?: string;
}

const chunkBuffers = new Map<string, ChunkBuffer>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let listenerStarted = false;

function flushChunks(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (chunkBuffers.size === 0) return;
  const store = useAgentChatStore.getState();
  for (const [chatId, buffer] of chunkBuffers) {
    store.appendStreamText(chatId, buffer.kind, buffer.text, buffer.parentToolCallId);
  }
  chunkBuffers.clear();
}

function flushChat(chatId: string): void {
  const buffer = chunkBuffers.get(chatId);
  if (!buffer) return;
  chunkBuffers.delete(chatId);
  useAgentChatStore
    .getState()
    .appendStreamText(chatId, buffer.kind, buffer.text, buffer.parentToolCallId);
}

function bufferChunk(
  chatId: string,
  kind: "assistant" | "thought",
  text: string,
  parentToolCallId?: string,
): void {
  const existing = chunkBuffers.get(chatId);
  if (existing && existing.kind === kind && existing.parentToolCallId === parentToolCallId) {
    existing.text += text;
  } else {
    // 换了流的种类（assistant↔thought）或归属（主↔子 agent）先排空旧的，保持条目顺序。
    if (existing) flushChat(chatId);
    chunkBuffers.set(chatId, { kind, text, parentToolCallId });
  }
  if (!flushTimer) {
    flushTimer = setTimeout(flushChunks, FLUSH_INTERVAL_MS);
  }
}

/** 历史列表需要重拉时在 window 上派发的事件名（agent 改了会话标题等）。 */
export const AGENT_CHAT_HISTORY_CHANGED_EVENT = "ccpanes:agent-chat-history-changed";

/** `ccpanes/auto-approved` 通知 → 一行留痕文本；非该通知返回 null。
 * 后端附带 `resolvedKind`（含标题推断的结果），比 toolCall.kind 更准。 */
export function describeAutoApproved(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const notification = data as {
    method?: string;
    resolvedKind?: string | null;
    params?: { toolCall?: { title?: string; kind?: string } };
  };
  if (notification.method !== "ccpanes/auto-approved") return null;
  const toolCall = notification.params?.toolCall;
  const kind = notification.resolvedKind ?? toolCall?.kind ?? "other";
  const title = toolCall?.title?.trim();
  return title
    ? i18n.t("agentChat.autoApprovedWith", { ns: "notifications", title, kind })
    : i18n.t("agentChat.autoApproved", { ns: "notifications", kind });
}

function dispatchAgentChatEvent(event: AcpChatEvent): void {
  const store = useAgentChatStore.getState();
  const { chatId, kind, payload } = event;
  if (kind === "update") {
    const params = payload as AcpSessionUpdate;
    const updateKind = params.update?.sessionUpdate;
    if (updateKind === "agent_message_chunk" || updateKind === "agent_thought_chunk") {
      const chunkContent = params.update?.content;
      // chunk 变体的 content 是单块；数组形态属于 tool_call 变体，此处不该出现。
      if (!Array.isArray(chunkContent)) {
        const block = chunkContent as
          | { type?: string; text?: string; data?: string; mimeType?: string }
          | undefined;
        const parentToolCallId = parentToolCallIdOf(params.update);
        // 接收侧图片块：真渲染而不是 [image] 占位。保序：先排空文本缓冲。
        if (block?.type === "image" && typeof block.data === "string") {
          flushChat(chatId);
          store.pushImage(chatId, block.mimeType ?? "image/png", block.data, parentToolCallId);
          return;
        }
        const text = contentText(block);
        if (text) {
          bufferChunk(
            chatId,
            updateKind === "agent_message_chunk" ? "assistant" : "thought",
            text,
            parentToolCallId,
          );
        }
      }
      return;
    }
    // 非 chunk 更新先排空该会话的缓冲，避免工具卡插到未 flush 的文本前面。
    flushChat(chatId);
    store.applySessionUpdate(chatId, params);
    // agent 标题已由后端写进历史 meta；通知侧栏「最近会话」立刻重拉，
    // 不用等下次窗口聚焦。
    if (updateKind === "session_info_update" && typeof window !== "undefined") {
      window.dispatchEvent(new Event(AGENT_CHAT_HISTORY_CHANGED_EVENT));
    }
    return;
  }

  flushChat(chatId);
  switch (kind) {
    case "state":
      store.setSnapshot(chatId, payload as AcpChatSnapshot);
      return;
    case "permission_request":
      store.enqueuePermission(chatId, payload as AcpPermissionRequest);
      return;
    case "turn_ended": {
      const data = payload as { stopReason?: string; error?: string };
      store.turnEnded(chatId, data.stopReason ?? "end_turn", data.error);
      return;
    }
    // 客户端 terminal 能力的实时输出（后端已去抖），工具卡里的 terminal 块据此渲染。
    case "terminal_output": {
      const data = payload as AcpTerminalOutput;
      if (typeof data?.terminalId === "string") store.setTerminalOutput(chatId, data);
      return;
    }
    case "notification": {
      const data = payload as { method?: string } | null;
      // 续接降级必须对用户可见（resume 链路的老教训：静默降级 = 用户以为
      // 上下文还在，实际是新会话）。
      if (
        data?.method === "ccpanes/load-failed"
        || data?.method === "ccpanes/load-unsupported"
      ) {
        store.pushNotice(chatId, i18n.t("agentChat.resumeFallbackNotice", { ns: "notifications" }));
        return;
      }
      // 自动放行也要留痕：用户勾了类别就看不到审批卡，得知道替他答了什么。
      const autoApproved = describeAutoApproved(data);
      if (autoApproved) store.pushNotice(chatId, autoApproved);
      return;
    }
    // protocol_noise：协议漂移与适配器杂音，开发期可从 console 观察，不进消息流。
    default:
      if (import.meta.env.DEV) {
        console.debug("[agent-chat] unhandled event", event);
      }
  }
}

/**
 * 关标签时的完整渲染态回收：消息流条目 + 未 flush 的 chunk 缓冲。
 * 由 tabLifecycle 的 agent-chat onClosed 调用（进程停止另走 agentChatService.stop）。
 */
export function dropAgentChatState(chatId: string): void {
  chunkBuffers.delete(chatId);
  useAgentChatStore.getState().dropChat(chatId);
}

/**
 * 幂等启动全局事件监听。组件挂载时调用；订阅失败静默降级
 * （web 模式没有 Tauri 事件，标签本身也不该出现在 web 模式）。
 */
export function ensureAgentChatListener(): void {
  if (listenerStarted) return;
  listenerStarted = true;
  void agentChatService
    .listen(dispatchAgentChatEvent)
    .catch((error) => {
      listenerStarted = false;
      handleErrorSilent(error, "subscribe agent chat events");
    });
}
