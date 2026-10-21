// ACP chat 全局渲染态：标签卸载后保留消息与会话快照。
// 会话真身在 Rust；Tauri 事件翻译与 chunk 合批由 agentChatEvents.ts 负责。
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type {
  AcpAvailableCommand,
  AcpChatSnapshot,
  AcpContentBlock,
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
import { createElicitationActions, type ElicitationActions, type ElicitationState } from "./agentChatElicitation";
import { seedForkTranscript } from "./agentChatForkTranscript";
import { dropAgentChatDraft } from "./useAgentChatDraftStore";
import { createPromptSubmissionActions, emptyPromptSubmission, observePromptPhase, type PromptSubmissionActions, type PromptSubmissionState } from "./agentChatPromptSubmission";

export type { PendingChatElicitation } from "./agentChatElicitation";

let itemSeq = 0;
let setupSeq = 0;
function nextItemId(): string {
  itemSeq += 1;
  return `aci-${Date.now().toString(36)}-${itemSeq}`;
}

export interface PendingChatPermission extends AcpPermissionRequest {
  responding: boolean;
  error: string | null;
}

export interface ChatSetupState {
  token: number;
  pending: boolean;
  error: string | null;
  firstPrompt?: string;
  preamble?: string;
}

export interface AgentChatSessionState extends PromptSubmissionState, ElicitationState {
  snapshot: AcpChatSnapshot | null;
  items: AgentChatItem[];
  /** 当前会话正文的起点；切项目留下的旧会话和分隔提示属于此前的只读前缀。 */
  transcriptSessionId: string | null;
  transcriptStart: number;
  replay: {
    acpSessionId: string;
    prefixLength: number;
    items: AgentChatItem[];
    terminals: Record<string, AcpTerminalOutput>;
  } | null;
  /** 由首页「对 agent 说」以编排管家身份发起的会话（决定欢迎态文案）。 */
  concierge: boolean;
  pendingPermissions: PendingChatPermission[];
  /** 后端 ready 仅代表握手完成；前端配置/目录提交完成前仍禁止输入。 */
  setup: ChatSetupState | null;
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

interface AgentChatStoreState extends PromptSubmissionActions, ElicitationActions {
  chats: Record<string, AgentChatSessionState>;
  setSnapshot: (chatId: string, snapshot: AcpChatSnapshot) => void;
  seedFork: (chatId: string, items: AgentChatItem[], acpSessionId: string, preservedPrefixLength?: number) => void;
  setConcierge: (chatId: string, concierge: boolean) => void;
  setCwdOverride: (chatId: string, cwd: string | null) => void;
  addUserMessage: (chatId: string, text: string, attachments?: AgentChatAttachment[], promptBlocks?: AcpContentBlock[]) => void;
  beginHistoryReplay: (chatId: string, acpSessionId: string) => void;
  finishHistoryReplay: (chatId: string, acpSessionId: string, commit: boolean) => void;
  preserveTranscriptPrefix: (chatId: string) => void;
  appendStreamText: (
    chatId: string,
    kind: "assistant" | "thought",
    text: string,
    parentToolCallId?: string,
  ) => void;
  pushImage: (chatId: string, mimeType: string, data: string, parentToolCallId?: string) => void;
  applySessionUpdate: (chatId: string, params: AcpSessionUpdate) => void;
  enqueuePermission: (chatId: string, request: AcpPermissionRequest) => void;
  beginPermissionResponse: (chatId: string, requestKey: string) => boolean;
  finishPermissionResponse: (chatId: string, requestKey: string, error?: string) => void;
  beginSetup: (chatId: string, prompt?: { firstPrompt?: string; preamble?: string }) => number | null;
  finishSetup: (chatId: string, token: number, error?: string) => void;
  pushNotice: (chatId: string, text: string) => void;
  turnEnded: (chatId: string, stopReason: string, error?: string) => void;
  setTerminalOutput: (chatId: string, output: AcpTerminalOutput) => void;
  dropChat: (chatId: string) => void;
}

function emptySession(): AgentChatSessionState {
  return {
    ...emptyPromptSubmission(),
    snapshot: null,
    items: [],
    transcriptSessionId: null,
    transcriptStart: 0,
    replay: null,
    concierge: false,
    pendingPermissions: [],
    pendingElicitations: [],
    setup: null,
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

/** 回放尚未确认成功时只写暂存区，让旧画面一直可读。 */
function contentItems(chat: AgentChatSessionState): AgentChatItem[] {
  return chat.replay?.items ?? chat.items;
}

/** 末尾若是仍在流式的思考块，记下收口时刻（"思考了 N 秒"的终点）。 */
function closeOpenThought(chat: AgentChatSessionState): void {
  const items = contentItems(chat);
  const last = items[items.length - 1];
  if (last && last.type === "thought" && last.doneAt === undefined) {
    last.doneAt = Date.now();
  }
}

/** 入列任何非思考条目前先收口思考块，再压入。 */
function pushItem(chat: AgentChatSessionState, item: AgentChatItem): void {
  if (item.type !== "thought") closeOpenThought(chat);
  contentItems(chat).push(item);
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
    ...createElicitationActions(set, (state, chatId) => ensure(state.chats, chatId)),
    ...createPromptSubmissionActions(set, (state, chatId) => ensure(state.chats, chatId), pushItem, nextItemId),

    seedFork: (chatId, items, acpSessionId, preservedPrefixLength = 0) => set((state) => {
      seedForkTranscript(ensure(state.chats, chatId), items, acpSessionId, preservedPrefixLength);
    }),

    setSnapshot: (chatId, snapshot) =>
      set((state) => {
        const chat = ensure(state.chats, chatId);
        const previousError = chat.snapshot?.error;
        observePromptPhase(chat, snapshot.phase);
        // 新进程起来（starting）= 新的上下文窗口，旧用量作废。
        if (snapshot.phase === "starting") chat.usage = null;
        if (snapshot.phase === "failed" || snapshot.phase === "exited") chat.replay = null;
        if (["starting", "exited", "failed"].includes(snapshot.phase)) {
          chat.pendingPermissions = [];
          chat.pendingElicitations = [];
        }
        if (snapshot.phase === "ready" && snapshot.acpSessionId && snapshot.acpSessionId !== chat.transcriptSessionId) {
          chat.transcriptSessionId = snapshot.acpSessionId;
          chat.transcriptStart = chat.items.length;
        }
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

    beginHistoryReplay: (chatId, acpSessionId) =>
      set((state) => {
        const chat = ensure(state.chats, chatId);
        chat.replay = {
          acpSessionId,
          prefixLength: chat.transcriptSessionId === acpSessionId ? chat.transcriptStart : chat.items.length,
          items: [],
          terminals: {},
        };
      }),

    finishHistoryReplay: (chatId, acpSessionId, commit) =>
      set((state) => {
        const chat = state.chats[chatId];
        const replay = chat?.replay;
        if (!chat || !replay || replay.acpSessionId !== acpSessionId) return;
        if (commit) {
          chat.items = [...chat.items.slice(0, replay.prefixLength), ...replay.items];
          chat.terminals = { ...chat.terminals, ...replay.terminals };
          chat.transcriptSessionId = acpSessionId;
          chat.transcriptStart = replay.prefixLength;
        }
        chat.replay = null;
      }),

    preserveTranscriptPrefix: (chatId) =>
      set((state) => {
        const chat = state.chats[chatId];
        if (chat && !chat.replay) chat.transcriptStart = chat.items.length;
      }),

    addUserMessage: (chatId, text, attachments, promptBlocks) =>
      set((state) => {
        const chat = ensure(state.chats, chatId);
        const labels = (attachments ?? []).map((attachment) => attachment.name);
        pushItem(chat, {
          type: "user",
          id: nextItemId(),
          at: Date.now(),
          text,
          ...(promptBlocks ? { promptBlocks } : {}),
          ...(labels.length > 0 ? { attachmentLabels: labels, attachments } : {}),
        });
      }),

    appendStreamText: (chatId, kind, text, parentToolCallId) =>
      set((state) => {
        if (!text) return;
        const chat = ensure(state.chats, chatId);
        const itemType = kind === "assistant" ? "assistant" : "thought";
        const items = contentItems(chat);
        const last = items[items.length - 1];
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
        const items = contentItems(chat);
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
            for (let index = items.length - 1; index >= 0; index -= 1) {
              const item = items[index];
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
            for (let index = items.length - 1; index >= 0; index -= 1) {
              const item = items[index];
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
            const blocks = update.content && !Array.isArray(update.content) ? [update.content] : [];
            const last = items[items.length - 1];
            if (last && last.type === "user") {
              last.text += text;
              last.promptBlocks = [...(last.promptBlocks ?? []), ...blocks];
            } else {
              pushItem(chat, { type: "user", id: nextItemId(), at: Date.now(), text, promptBlocks: blocks });
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
            const seen = items.some(
              (item) => item.type === "notice" && item.text === text,
            );
            if (!seen) {
              pushItem(chat, { type: "notice", id: nextItemId(), at: Date.now(), text });
            }
            return;
          }
        }
      }),

    enqueuePermission: (chatId, request) =>
      set((state) => {
        const chat = ensure(state.chats, chatId);
        const existing = chat.pendingPermissions.find((item) => item.requestKey === request.requestKey);
        if (existing) existing.params = request.params;
        else chat.pendingPermissions.push({ ...request, responding: false, error: null });
      }),

    beginPermissionResponse: (chatId, requestKey) => {
      let started = false;
      set((state) => {
        const request = state.chats[chatId]?.pendingPermissions.find((item) => item.requestKey === requestKey);
        if (!request || request.responding) return;
        request.responding = true;
        request.error = null;
        started = true;
      });
      return started;
    },

    finishPermissionResponse: (chatId, requestKey, error) =>
      set((state) => {
        const chat = state.chats[chatId];
        if (!chat) return;
        const request = chat.pendingPermissions.find((item) => item.requestKey === requestKey);
        if (!request) return;
        if (error !== undefined) {
          request.responding = false;
          request.error = error;
        } else {
          chat.pendingPermissions = chat.pendingPermissions.filter((item) => item.requestKey !== requestKey);
        }
      }),

    beginSetup: (chatId, prompt) => {
      let token: number | null = null;
      set((state) => {
        const chat = ensure(state.chats, chatId);
        if (chat.setup?.pending || chat.pendingPrompt) return;
        token = ++setupSeq;
        chat.setup = { token, pending: true, error: null, ...prompt };
      });
      return token;
    },

    finishSetup: (chatId, token, error) =>
      set((state) => {
        const chat = state.chats[chatId];
        if (!chat?.setup || chat.setup.token !== token) return;
        if (error !== undefined) {
          chat.setup.pending = false;
          chat.setup.error = error;
        } else chat.setup = null;
      }),

    pushNotice: (chatId, text) =>
      set((state) => {
        const chat = ensure(state.chats, chatId);
        pushItem(chat, { type: "notice", id: nextItemId(), at: Date.now(), text });
      }),

    turnEnded: (chatId, stopReason, error) =>
      set((state) => {
        const chat = ensure(state.chats, chatId);
        observePromptPhase(chat, "turn_ended");
        // 回合结束后审批卡必然失效（agent 已用 cancelled 收场）。
        chat.pendingPermissions = [];
        chat.pendingElicitations = [];
        closeOpenThought(chat);
        if (stopReason !== "end_turn") {
          const text = error ? `${stopReason}: ${error}` : `[${stopReason}]`;
          pushItem(chat, { type: "notice", id: nextItemId(), at: Date.now(), text });
        }
      }),

    setTerminalOutput: (chatId, output) =>
      set((state) => {
        const chat = ensure(state.chats, chatId);
        (chat.replay?.terminals ?? chat.terminals)[output.terminalId] = output;
      }),

    dropChat: (chatId) => {
      dropAgentChatDraft(chatId);
      set((state) => { delete state.chats[chatId]; });
    },
  })),
);

