// 换引擎「上下文交接」的确定性摘要：不调用 LLM，只从渲染层条目里摘
// user / assistant 正文（倒序取最近轮次，单条截断，总长封顶），再附上本对话
// 改动过的文件路径。结果作为切换后首条消息的前置 text block 发给新引擎。
import type { AgentChatItem } from "@/types/agentChat";
import { completedFileEdits } from "./fileEdits";

export const HANDOFF_MAX_CHARS = 12_000;
export const HANDOFF_MAX_MESSAGE_CHARS = 2_000;
export const HANDOFF_MAX_FILES = 50;

export interface HandoffSummaryOptions {
  fromLabel: string;
  toLabel: string;
  /** 整段上限（含说明与文件列表）。 */
  maxChars?: number;
  /** 单条消息截断长度。 */
  maxMessageChars?: number;
}

interface HandoffMessage {
  role: "user" | "assistant";
  text: string;
}

const EDIT_KINDS = new Set(["edit", "delete", "move"]);

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 16)).trimEnd()} …[truncated]`;
}

/** user / 主 agent 的 assistant 正文；相邻同角色合并（工具卡把一条回复切成多段）。 */
export function collectHandoffMessages(items: readonly AgentChatItem[]): HandoffMessage[] {
  const messages: HandoffMessage[] = [];
  for (const item of items) {
    if (item.type !== "user" && item.type !== "assistant") continue;
    if (item.type === "assistant" && item.parentToolCallId) continue;
    const text = item.text.trim();
    if (!text) continue;
    const last = messages[messages.length - 1];
    if (last && last.role === item.type) last.text = `${last.text}\n\n${text}`;
    else messages.push({ role: item.type, text });
  }
  return messages;
}

/** 本对话里改动过的文件（成功的 diff 块 + 已完成的编辑类工具位置），按首次出现排序去重。 */
export function collectEditedFiles(items: readonly AgentChatItem[]): string[] {
  const seen = new Set<string>();
  const add = (path: string | undefined) => {
    const trimmed = path?.trim();
    if (trimmed && !seen.has(trimmed)) seen.add(trimmed);
  };
  for (const item of items) {
    if (item.type !== "tool_call") continue;
    for (const block of completedFileEdits(item.call)) add(block.path);
    if (item.call.status === "completed" && item.call.kind && EDIT_KINDS.has(item.call.kind)) {
      for (const location of item.call.locations ?? []) add(location.path);
    }
  }
  return [...seen];
}

function formatMessage(message: HandoffMessage, limit: number): string {
  return `[${message.role === "user" ? "User" : "Assistant"}]\n${truncate(message.text, limit)}`;
}

/** 生成交接上下文；没有任何正文和文件改动时返回 null（无需交接）。 */
export function buildHandoffSummary(items: readonly AgentChatItem[], options: HandoffSummaryOptions): string | null {
  const maxChars = options.maxChars ?? HANDOFF_MAX_CHARS;
  const maxMessageChars = options.maxMessageChars ?? HANDOFF_MAX_MESSAGE_CHARS;
  const messages = collectHandoffMessages(items);
  const files = collectEditedFiles(items);
  if (messages.length === 0 && files.length === 0) return null;

  const header = [
    "<handoff_context>",
    `This conversation was previously handled by ${options.fromLabel} and has been handed off to you (${options.toLabel}).`,
    "Below is a deterministic excerpt of the earlier conversation for context only. Do not reply to it directly;",
    "answer the user's new message that follows this block.",
  ].join("\n");
  const shownFiles = files.slice(0, HANDOFF_MAX_FILES);
  const fileSection = files.length === 0 ? "" : [
    "",
    "## Files changed in this conversation",
    ...shownFiles.map((path) => `- ${path}`),
    ...(files.length > shownFiles.length ? [`- … ${files.length - shownFiles.length} more`] : []),
  ].join("\n");
  const footer = "</handoff_context>";
  const sectionTitle = "\n## Earlier conversation (oldest first)\n";
  const fixed = header.length + fileSection.length + footer.length + sectionTitle.length + 2;
  const budget = Math.max(0, maxChars - fixed);

  const rendered = messages.map((message) => formatMessage(message, maxMessageChars));
  const joinedLength = (parts: string[]) => parts.reduce((sum, part) => sum + part.length + 2, 0);
  let body: string[];
  if (joinedLength(rendered) <= budget) {
    body = rendered;
  } else {
    // 放不下：保留最早一条用户提问（任务起点）+ 尽量多的最近轮次，中间注明省略。
    const firstUser = messages.findIndex((message) => message.role === "user");
    const anchor = firstUser >= 0 ? formatMessage(messages[firstUser], Math.min(maxMessageChars, Math.floor(budget / 4))) : null;
    const omissionReserve = 64;
    let remaining = budget - (anchor ? anchor.length + 2 : 0) - omissionReserve;
    const recent: string[] = [];
    for (let index = rendered.length - 1; index > firstUser; index -= 1) {
      const cost = rendered[index].length + 2;
      if (cost > remaining) break;
      recent.unshift(rendered[index]);
      remaining -= cost;
    }
    const omitted = rendered.length - recent.length - (anchor ? 1 : 0);
    body = [
      ...(anchor ? [anchor] : []),
      ...(omitted > 0 ? [`[… ${omitted} earlier message(s) omitted …]`] : []),
      ...recent,
    ];
  }

  const transcript = body.length > 0 ? `${sectionTitle}${body.join("\n\n")}` : "";
  return `${header}\n${transcript}${fileSection}\n${footer}`;
}
