// ACP chat 状态（agent-chat 标签的消息流 + 会话快照）。
//
// 状态放全局 store 而不是组件里：标签切走时组件会卸载（keep-alive 不覆盖
// pane 内容区），重挂载后消息流必须还在。会话真身在 Rust 进程里，这里只是
// 渲染态。
//
// Tauri 事件 → 这里的动作的翻译（含 chunk 合批）在 agentChatEvents.ts。
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type {
  AcpAvailableCommand,
  AcpChatSnapshot,
  AcpPermissionRequest,
  AcpPlanEntry,
  AcpSessionUpdate,
  AcpTerminalOutput,
  AcpToolCall,
  AcpUsage,
  AgentChatAttachment,
  AgentChatItem,
} from "@/types/agentChat";
import { parentToolCallIdOf } from "@/types/agentChat";

let itemSeq = 0;
function nextItemId(): string {
  itemSeq += 1;
  return `aci-${Date.now().toString(36)}-${itemSeq}`;
}

export interface AgentChatSessionState {
  snapshot: AcpChatSnapshot | null;
  items: AgentChatItem[];
  /** 由首页「对 agent 说」以编排管家身份发起的会话（决定欢迎态文案）。 */
  concierge: boolean;
  pendingPermission: AcpPermissionRequest | null;
  /** agent 广告的斜杠命令目录（available_commands_update 整表替换）。 */
  availableCommands: AcpAvailableCommand[];
  /** 上下文窗口用量（usage_update 整体替换）；引擎不上报时为 null，UI 不显示。 */
  usage: AcpUsage | null;
  /** 会话中途切换的工作空间/目录（顶栏 chip）。存 store 而非组件 state：
   * 标签卸载重挂载不丢；优先级高于 tab.projectPath。null = 未覆盖。 */
  cwdOverride: string | null;
  /** agent 经客户端 `terminal/*` 能力开的终端（terminalId → 最新输出快照）。 */
  terminals: Record<string, AcpTerminalOutput>;
}

interface AgentChatStoreState {
  chats: Record<string, AgentChatSessionState>;
  setSnapshot: (chatId: string, snapshot: AcpChatSnapshot) => void;
  setConcierge: (chatId: string, concierge: boolean) => void;
  setCwdOverride: (chatId: string, cwd: string | null) => void;
  addUserMessage: (chatId: string, text: string, attachments?: AgentChatAttachment[]) => void;
  appendStreamText: (
    chatId: string,
    kind: "assistant" | "thought",
    text: string,
    parentToolCallId?: string,
  ) => void;
  pushImage: (chatId: string, mimeType: string, data: string, parentToolCallId?: string) => void;
  applySessionUpdate: (chatId: string, params: AcpSessionUpdate) => void;
  setPermission: (chatId: string, request: AcpPermissionRequest | null) => void;
  pushNotice: (chatId: string, text: string) => void;
  turnEnded: (chatId: string, stopReason: string, error?: string) => void;
  setTerminalOutput: (chatId: string, output: AcpTerminalOutput) => void;
  dropChat: (chatId: string) => void;
}

function emptySession(): AgentChatSessionState {
  return {
    snapshot: null,
    items: [],
    concierge: false,
    pendingPermission: null,
    availableCommands: [],
    usage: null,
    terminals: {},
    cwdOverride: null,
  };
}

function ensure(chats: Record<string, AgentChatSessionState>, chatId: string): AgentChatSessionState {
  if (!chats[chatId]) {
    chats[chatId] = emptySession();
  }
  return chats[chatId];
}

/** 末尾若是仍在流式的思考块，记下收口时刻（"思考了 N 秒"的终点）。 */
function closeOpenThought(chat: AgentChatSessionState): void {
  const last = chat.items[chat.items.length - 1];
  if (last && last.type === "thought" && last.doneAt === undefined) {
    last.doneAt = Date.now();
  }
}

/** 入列任何非思考条目前先收口思考块，再压入。 */
function pushItem(chat: AgentChatSessionState, item: AgentChatItem): void {
  if (item.type !== "thought") closeOpenThought(chat);
  chat.items.push(item);
}

/** 从 ContentBlock 提取可显示文本；非 text 变体降级为类型占位。 */
export function contentText(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const block = content as { type?: string; text?: string };
  if (typeof block.text === "string") return block.text;
  return block.type ? `[${block.type}]` : "";
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
        // 新进程起来（starting）= 新的上下文窗口，旧用量作废。
        if (snapshot.phase === "starting") chat.usage = null;
        chat.snapshot = snapshot;
        // 失败/异常退出要成为消息流的一部分，不然用户只看到输入框变灰。
        if (snapshot.error && snapshot.error !== previousError) {
          pushItem(chat, { type: "notice", id: nextItemId(), at: Date.now(), text: snapshot.error });
        }
      }),

    setConcierge: (chatId, concierge) =>
      set((state) => {
        ensure(state.chats, chatId).concierge = concierge;
      }),

    setCwdOverride: (chatId, cwd) =>
      set((state) => {
        ensure(state.chats, chatId).cwdOverride = cwd;
      }),

    addUserMessage: (chatId, text, attachments) =>
      set((state) => {
        const chat = ensure(state.chats, chatId);
        const labels = (attachments ?? []).map((attachment) => attachment.name);
        pushItem(chat, {
          type: "user",
          id: nextItemId(),
          at: Date.now(),
          text,
          ...(labels.length > 0 ? { attachmentLabels: labels, attachments } : {}),
        });
      }),

    appendStreamText: (chatId, kind, text, parentToolCallId) =>
      set((state) => {
        if (!text) return;
        const chat = ensure(state.chats, chatId);
        const itemType = kind === "assistant" ? "assistant" : "thought";
        const last = chat.items[chat.items.length - 1];
        // 邻接同类且同归属 → 续写同一气泡；被工具卡等打断、或主/子 agent 交替 → 新气泡。
        if (last && last.type === itemType && last.parentToolCallId === parentToolCallId) {
          last.text += text;
        } else {
          pushItem(chat, {
            type: itemType,
            id: nextItemId(),
            at: Date.now(),
            text,
            ...(parentToolCallId ? { parentToolCallId } : {}),
          });
        }
      }),

    pushImage: (chatId, mimeType, data, parentToolCallId) =>
      set((state) => {
        const chat = ensure(state.chats, chatId);
        pushItem(chat, {
          type: "image",
          id: nextItemId(),
          at: Date.now(),
          mimeType,
          data,
          ...(parentToolCallId ? { parentToolCallId } : {}),
        });
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
            const parentToolCallId = parentToolCallIdOf(update);
            pushItem(chat, {
              type: "tool_call",
              id: nextItemId(),
              at: Date.now(),
              call,
              ...(parentToolCallId ? { parentToolCallId } : {}),
            });
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
            const parentToolCallId = parentToolCallIdOf(update);
            pushItem(chat, {
              type: "tool_call",
              id: nextItemId(),
              at: Date.now(),
              call,
              ...(parentToolCallId ? { parentToolCallId } : {}),
            });
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
            pushItem(chat, { type: "plan", id: nextItemId(), at: Date.now(), entries });
            return;
          }
          // session/load 回放会重放历史用户消息（发生在 starting 相位），必须
          // 收下，否则恢复出的对话缺所有用户气泡；活回合（generating）里的
          // 回显则丢弃——本地发送时已经入列过了。
          case "user_message_chunk": {
            if (chat.snapshot?.phase === "generating") return;
            const text = contentText(update.content);
            if (!text) return;
            const last = chat.items[chat.items.length - 1];
            if (last && last.type === "user") {
              last.text += text;
            } else {
              pushItem(chat, { type: "user", id: nextItemId(), at: Date.now(), text });
            }
            return;
          }
          case "available_commands_update": {
            const commands = update.availableCommands;
            chat.availableCommands = Array.isArray(commands)
              ? (commands as AcpAvailableCommand[])
              : [];
            return;
          }
          // 模式变更由后端同步进快照并 emit state，前端这里无事可做。
          case "current_mode_update":
            return;
          // agent 生成的会话标题由后端写进历史 meta（实测 claude/codex/copilot/
          // cursor 都发）；配置项变更由后端同步进快照并 emit state。两者都不是对话内容。
          case "session_info_update":
          case "config_option_update":
            return;
          // 上下文用量：size 为 0/缺失时按「未上报」处理（RFD 规定 size 必有）。
          case "usage_update": {
            const used = update.used;
            const size = update.size;
            if (typeof used !== "number" || typeof size !== "number" || size <= 0) return;
            const cost = update.cost;
            chat.usage = {
              used: Math.max(0, used),
              size,
              cost:
                cost && typeof cost === "object"
                  && typeof (cost as { amount?: unknown }).amount === "number"
                  ? (cost as AcpUsage["cost"])
                  : null,
            };
            return;
          }
          default: {
            // 未知变体保持可见（v1→v2 过渡期的协议漂移探针），但同类只提示一次。
            const text = `[ACP] 未渲染的更新类型: ${update.sessionUpdate}`;
            const seen = chat.items.some(
              (item) => item.type === "notice" && item.text === text,
            );
            if (!seen) {
              pushItem(chat, { type: "notice", id: nextItemId(), at: Date.now(), text });
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
        pushItem(chat, { type: "notice", id: nextItemId(), at: Date.now(), text });
      }),

    turnEnded: (chatId, stopReason, error) =>
      set((state) => {
        const chat = ensure(state.chats, chatId);
        // 回合结束后审批卡必然失效（agent 已用 cancelled 收场）。
        chat.pendingPermission = null;
        closeOpenThought(chat);
        if (stopReason !== "end_turn") {
          const text = error ? `${stopReason}: ${error}` : `[${stopReason}]`;
          pushItem(chat, { type: "notice", id: nextItemId(), at: Date.now(), text });
        }
      }),

    setTerminalOutput: (chatId, output) =>
      set((state) => {
        const chat = ensure(state.chats, chatId);
        chat.terminals[output.terminalId] = output;
      }),

    dropChat: (chatId) =>
      set((state) => {
        delete state.chats[chatId];
      }),
  })),
);

