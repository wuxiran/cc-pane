// 消息正文本地落盘兜底（docs/94 §8）：非 loadSession 引擎续接后画面不再是空的。
//
// 保存：回合结束 / 会话退出 / 关标签时，把当前会话正文段（transcriptStart 之后）
// 整段交后端按 acpSessionId 落盘。只读前缀（旧会话、切项目留下的、恢复出来的）
// 不重复保存——恢复出来的那段后端已作为新会话的 inherited 段继承。
// 恢复：后端在降级开新会话时推 `transcript_restore`（先于 ready），这里把旧转写
// 夹在两条分隔线之间放进只读前缀。loadSession 成功的引擎走协议回放，不会收到它。
import i18n from "@/i18n";
import { agentChatService } from "@/services/agentChatService";
import type { AgentChatItem } from "@/types/agentChat";
import { handleErrorSilent } from "@/utils/errorHandler";
import { emptySession, useAgentChatStore } from "./useAgentChatStore";

/** 超过这个长度的内嵌图片不落盘（base64 字符数）；后端另有字符串长度硬上限。 */
export const MAX_PERSISTED_IMAGE_CHARS = 48 * 1024;
const ITEM_TYPES = new Set(["user", "assistant", "thought", "image", "tool_call", "plan", "notice"]);

const saveChains = new Map<string, Promise<void>>();

function omittedImageNotice(item: { id: string; at: number }): AgentChatItem {
  return {
    type: "notice",
    id: item.id,
    at: item.at,
    text: i18n.t("agentChat.transcriptImageOmitted", { ns: "notifications" }),
  };
}

/** 落盘投影：去掉附件原文与 promptBlocks（只读回看不需要重试），大图降级为占位。 */
export function sanitizeTranscriptItems(items: readonly AgentChatItem[]): AgentChatItem[] {
  return items.map((item) => {
    if (item.type === "user") {
      const { attachments: _attachments, promptBlocks: _promptBlocks, ...rest } = item;
      return rest;
    }
    if (item.type === "image" && item.data.length > MAX_PERSISTED_IMAGE_CHARS) {
      return omittedImageNotice(item);
    }
    return item;
  });
}

/** 当前会话正文段排队落盘；同一会话的保存串行，避免旧快照后到覆盖新快照。 */
export function persistAgentChatTranscript(chatId: string): void {
  const chat = useAgentChatStore.getState().chats[chatId];
  const sessionId = chat?.transcriptSessionId;
  if (!chat || chat.replay || !sessionId) return;
  const current = chat.items.slice(chat.transcriptStart);
  // 只有系统留痕时不写，免得空壳覆盖掉之前保存过的正文。
  if (!current.some((item) => item.type !== "notice")) return;
  const items = sanitizeTranscriptItems(current);
  const previous = saveChains.get(sessionId) ?? Promise.resolve();
  const next = previous
    .then(() => agentChatService.saveTranscript(sessionId, items))
    .catch((error: unknown) => handleErrorSilent(error, "save agent chat transcript"));
  saveChains.set(sessionId, next);
  void next.finally(() => {
    if (saveChains.get(sessionId) === next) saveChains.delete(sessionId);
  });
}

function restoredItem(raw: unknown, id: string): AgentChatItem | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as AgentChatItem & { dataOmitted?: boolean };
  if (!ITEM_TYPES.has(item.type) || typeof item.at !== "number") return null;
  if (item.type === "image" && (item.dataOmitted || typeof item.data !== "string")) {
    return omittedImageNotice({ id, at: item.at });
  }
  return { ...item, id } as AgentChatItem;
}

interface TranscriptRestorePayload {
  fromAcpSessionId?: unknown;
  acpSessionId?: unknown;
  items?: unknown;
  truncated?: unknown;
}

/** `transcript_restore` → 只读前缀：「之前的对话记录」…「以下为恢复后的新会话」。 */
export function applyRestoredTranscript(chatId: string, payload: unknown): void {
  const data = (payload ?? {}) as TranscriptRestorePayload;
  const from = data.fromAcpSessionId;
  const to = data.acpSessionId;
  if (typeof from !== "string" || typeof to !== "string" || !Array.isArray(data.items)) return;
  const restored = data.items
    .map((raw, index) => restoredItem(raw, `rst-${to}-${index}`))
    .filter((item): item is AgentChatItem => item !== null);
  if (restored.length === 0) return;
  const now = Date.now();
  const first = restored[0].at;
  const headerKey = data.truncated === true ? "agentChat.restoredTranscriptHeaderTruncated" : "agentChat.restoredTranscriptHeader";
  const block: AgentChatItem[] = [
    { type: "notice", id: `rst-${to}-head`, at: first, divider: true, text: i18n.t(headerKey, { ns: "notifications" }) },
    ...restored,
    {
      type: "notice",
      id: `rst-${to}-tail`,
      at: now,
      divider: true,
      text: i18n.t("agentChat.restoredTranscriptFooter", { ns: "notifications" }),
    },
  ];
  useAgentChatStore.setState((state) => {
    const chat = (state.chats[chatId] ??= emptySession());
    if (chat.items.some((item) => item.id === `rst-${to}-head`)) return;
    // 同一标签原地重启：旧会话正文还在画面上，不再叠一份。
    const visible = chat.items.slice(chat.transcriptStart);
    if (chat.transcriptSessionId === from && visible.some((item) => item.type !== "notice")) return;
    if (chat.transcriptSessionId === to) {
      // ready 已先到：插到新会话正文起点之前，并把起点后移，保持只读前缀语义。
      chat.items.splice(chat.transcriptStart, 0, ...block);
      chat.transcriptStart += block.length;
    } else {
      // ready 未到：追加即可，ready 时 transcriptStart = items.length 自然把它划进前缀。
      chat.items.push(...block);
    }
  });
}
