// ACP chat 状态（agent-chat 标签的消息流 + 会话快照）。
//
// 状态放全局 store 而不是组件里：标签切走时组件会卸载（keep-alive 不覆盖
// pane 内容区），重挂载后消息流必须还在。会话真身在 Rust 进程里，这里只是
// 渲染态。
//
// 高频 token 流不直接进 store：`agent_message_chunk` 接近逐 token 到达，每条
// 都走 Immer set() 就是渲染风暴（xterm 输出洪水的同族问题）。事件监听层把
// 相邻同类 chunk 合批 16ms 再 flush，非 chunk 事件先排空缓冲保序。
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { agentChatService } from "@/services/agentChatService";
import { handleErrorSilent } from "@/utils/errorHandler";
import type {
  AcpChatEvent,
  AcpChatSnapshot,
  AcpPermissionRequest,
  AcpPlanEntry,
  AcpSessionUpdate,
  AcpToolCall,
  AgentChatItem,
} from "@/types/agentChat";

let itemSeq = 0;
function nextItemId(): string {
  itemSeq += 1;
  return `aci-${Date.now().toString(36)}-${itemSeq}`;
}

export interface AgentChatSessionState {
  snapshot: AcpChatSnapshot | null;
  items: AgentChatItem[];
  pendingPermission: AcpPermissionRequest | null;
}

interface AgentChatStoreState {
  chats: Record<string, AgentChatSessionState>;
  setSnapshot: (chatId: string, snapshot: AcpChatSnapshot) => void;
  addUserMessage: (chatId: string, text: string) => void;
  appendStreamText: (chatId: string, kind: "assistant" | "thought", text: string) => void;
  applySessionUpdate: (chatId: string, params: AcpSessionUpdate) => void;
  setPermission: (chatId: string, request: AcpPermissionRequest | null) => void;
  pushNotice: (chatId: string, text: string) => void;
  turnEnded: (chatId: string, stopReason: string, error?: string) => void;
  dropChat: (chatId: string) => void;
}

function emptySession(): AgentChatSessionState {
  return { snapshot: null, items: [], pendingPermission: null };
}

function ensure(chats: Record<string, AgentChatSessionState>, chatId: string): AgentChatSessionState {
  if (!chats[chatId]) {
    chats[chatId] = emptySession();
  }
  return chats[chatId];
}

/** 从 ContentBlock 提取可显示文本；非 text 变体降级为类型占位。 */
function contentText(content: { type?: string; text?: string } | undefined): string {
  if (!content) return "";
  if (typeof content.text === "string") return content.text;
  return content.type ? `[${content.type}]` : "";
}

type ToolCallPatch = NonNullable<AcpSessionUpdate["update"]>;

function mergeToolCall(existing: AcpToolCall, patch: ToolCallPatch): void {
  if (patch.title !== undefined && patch.title !== null) existing.title = patch.title;
  if (patch.kind !== undefined && patch.kind !== null) existing.kind = patch.kind;
  if (patch.status !== undefined && patch.status !== null) existing.status = patch.status;
  // 按 ACP 语义：content / locations 是整表替换，不是追加。
  // tool_call 变体的 content 只可能是数组；单块形态属于 chunk 变体，忽略。
  if (Array.isArray(patch.content)) existing.content = patch.content;
  if (patch.locations !== undefined && patch.locations !== null) existing.locations = patch.locations;
  if (patch.rawInput !== undefined) existing.rawInput = patch.rawInput;
  if (patch.rawOutput !== undefined) existing.rawOutput = patch.rawOutput;
}

export const useAgentChatStore = create<AgentChatStoreState>()(
  immer((set) => ({
    chats: {},

    setSnapshot: (chatId, snapshot) =>
      set((state) => {
        const chat = ensure(state.chats, chatId);
        const previousError = chat.snapshot?.error;
        chat.snapshot = snapshot;
        // 失败/异常退出要成为消息流的一部分，不然用户只看到输入框变灰。
        if (snapshot.error && snapshot.error !== previousError) {
          chat.items.push({ type: "notice", id: nextItemId(), text: snapshot.error });
        }
      }),

    addUserMessage: (chatId, text) =>
      set((state) => {
        const chat = ensure(state.chats, chatId);
        chat.items.push({ type: "user", id: nextItemId(), text });
      }),

    appendStreamText: (chatId, kind, text) =>
      set((state) => {
        if (!text) return;
        const chat = ensure(state.chats, chatId);
        const itemType = kind === "assistant" ? "assistant" : "thought";
        const last = chat.items[chat.items.length - 1];
        // 邻接同类 → 续写同一气泡；被工具卡等打断 → 新气泡（保持时序）。
        if (last && last.type === itemType) {
          last.text += text;
        } else {
          chat.items.push({ type: itemType, id: nextItemId(), text });
        }
      }),

    applySessionUpdate: (chatId, params) =>
      set((state) => {
        const chat = ensure(state.chats, chatId);
        const update = params.update;
        if (!update || typeof update.sessionUpdate !== "string") return;
        switch (update.sessionUpdate) {
          case "tool_call": {
            const toolCallId = update.toolCallId;
            if (!toolCallId) return;
            const call: AcpToolCall = { toolCallId };
            mergeToolCall(call, update);
            chat.items.push({ type: "tool_call", id: nextItemId(), call });
            return;
          }
          case "tool_call_update": {
            const toolCallId = update.toolCallId;
            if (!toolCallId) return;
            for (let index = chat.items.length - 1; index >= 0; index -= 1) {
              const item = chat.items[index];
              if (item.type === "tool_call" && item.call.toolCallId === toolCallId) {
                mergeToolCall(item.call, update);
                return;
              }
            }
            // 没见过 tool_call 就来 update：按 ACP 容错语义当作新卡片。
            const call: AcpToolCall = { toolCallId };
            mergeToolCall(call, update);
            chat.items.push({ type: "tool_call", id: nextItemId(), call });
            return;
          }
          case "plan": {
            const entries = (update.entries ?? []) as AcpPlanEntry[];
            for (let index = chat.items.length - 1; index >= 0; index -= 1) {
              const item = chat.items[index];
              if (item.type === "plan") {
                item.entries = entries;
                return;
              }
            }
            chat.items.push({ type: "plan", id: nextItemId(), entries });
            return;
          }
          // 我们在发送时本地入列，回显丢弃即可。
          case "user_message_chunk":
            return;
          // 模式/命令目录暂无 UI 消费点。
          case "available_commands_update":
          case "current_mode_update":
            return;
          default: {
            // 未知变体保持可见（v1→v2 过渡期的协议漂移探针），但同类只提示一次。
            const text = `[ACP] 未渲染的更新类型: ${update.sessionUpdate}`;
            const seen = chat.items.some(
              (item) => item.type === "notice" && item.text === text,
            );
            if (!seen) {
              chat.items.push({ type: "notice", id: nextItemId(), text });
            }
            return;
          }
        }
      }),

    setPermission: (chatId, request) =>
      set((state) => {
        const chat = ensure(state.chats, chatId);
        chat.pendingPermission = request;
      }),

    pushNotice: (chatId, text) =>
      set((state) => {
        const chat = ensure(state.chats, chatId);
        chat.items.push({ type: "notice", id: nextItemId(), text });
      }),

    turnEnded: (chatId, stopReason, error) =>
      set((state) => {
        const chat = ensure(state.chats, chatId);
        // 回合结束后审批卡必然失效（agent 已用 cancelled 收场）。
        chat.pendingPermission = null;
        if (stopReason !== "end_turn") {
          const text = error ? `${stopReason}: ${error}` : `[${stopReason}]`;
          chat.items.push({ type: "notice", id: nextItemId(), text });
        }
      }),

    dropChat: (chatId) =>
      set((state) => {
        delete state.chats[chatId];
      }),
  })),
);

// ---------------------------------------------------------------------------
// 事件桥：全局单例监听 + chunk 合批。
// ---------------------------------------------------------------------------

const FLUSH_INTERVAL_MS = 16;

interface ChunkBuffer {
  kind: "assistant" | "thought";
  text: string;
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
    store.appendStreamText(chatId, buffer.kind, buffer.text);
  }
  chunkBuffers.clear();
}

function flushChat(chatId: string): void {
  const buffer = chunkBuffers.get(chatId);
  if (!buffer) return;
  chunkBuffers.delete(chatId);
  useAgentChatStore.getState().appendStreamText(chatId, buffer.kind, buffer.text);
}

function bufferChunk(chatId: string, kind: "assistant" | "thought", text: string): void {
  const existing = chunkBuffers.get(chatId);
  if (existing && existing.kind === kind) {
    existing.text += text;
  } else {
    // 换了流的种类（assistant↔thought）先排空旧的，保持条目顺序。
    if (existing) flushChat(chatId);
    chunkBuffers.set(chatId, { kind, text });
  }
  if (!flushTimer) {
    flushTimer = setTimeout(flushChunks, FLUSH_INTERVAL_MS);
  }
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
      const text = Array.isArray(chunkContent) ? "" : contentText(chunkContent);
      if (text) {
        bufferChunk(chatId, updateKind === "agent_message_chunk" ? "assistant" : "thought", text);
      }
      return;
    }
    // 非 chunk 更新先排空该会话的缓冲，避免工具卡插到未 flush 的文本前面。
    flushChat(chatId);
    store.applySessionUpdate(chatId, params);
    return;
  }

  flushChat(chatId);
  switch (kind) {
    case "state":
      store.setSnapshot(chatId, payload as AcpChatSnapshot);
      return;
    case "permission_request":
      store.setPermission(chatId, payload as AcpPermissionRequest);
      return;
    case "turn_ended": {
      const data = payload as { stopReason?: string; error?: string };
      store.turnEnded(chatId, data.stopReason ?? "end_turn", data.error);
      return;
    }
    // protocol_noise / notification：协议漂移与适配器杂音，开发期可从
    // console 观察，不进消息流。
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
