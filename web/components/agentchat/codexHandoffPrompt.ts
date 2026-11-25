import type { AgentChatItem } from "@/types/agentChat";

/** Codex 深链 prompt 的 UTF-8 字节上限（与后端 deeplink 校验同口径）。 */
export const CODEX_HANDOFF_MAX_BYTES = 8192;
/** 预填引用时给用户自己的指令留出的空间。 */
const INSTRUCTION_RESERVE_BYTES = 1024;
const TRUNCATION_MARK = "> …";

const encoder = new TextEncoder();
export function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

export function isHandoffPromptValid(prompt: string): boolean {
  return prompt.trim().length > 0 && utf8Bytes(prompt) <= CODEX_HANDOFF_MAX_BYTES;
}

function quoteLines(text: string): string {
  return text.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
}

export interface QuotedHandoff { text: string; truncated: boolean }

/**
 * 把选中内容 / 回复转成 Markdown 引用块，后接空行留给用户写指令。
 * 超出预算时按码点截断并以 `> …` 收尾——绝不静默产出超限文本。
 * `existingBytes`：引用要插到已有文本前时，已有文本占用的字节。
 */
export function quoteForHandoff(source: string, existingBytes = 0): QuotedHandoff {
  const normalized = source.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return { text: "", truncated: false };
  const budget = CODEX_HANDOFF_MAX_BYTES - INSTRUCTION_RESERVE_BYTES - existingBytes;
  const full = `${quoteLines(normalized)}\n\n`;
  if (utf8Bytes(full) <= budget) return { text: full, truncated: false };
  const chars = Array.from(normalized);
  const build = (count: number) => `${quoteLines(chars.slice(0, count).join("").trimEnd())}\n${TRUNCATION_MARK}\n\n`;
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8Bytes(build(mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  if (low === 0) return { text: budget >= utf8Bytes(`${TRUNCATION_MARK}\n\n`) ? `${TRUNCATION_MARK}\n\n` : "", truncated: true };
  return { text: build(low), truncated: true };
}

/** 最后一个回合里 agent 的顶层回复文本（子 agent 产出不算）。 */
export function lastAssistantReply(items: readonly AgentChatItem[]): string {
  let end = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type === "assistant" && !item.parentToolCallId && item.text.trim()) { end = index; break; }
  }
  if (end < 0) return "";
  const parts: string[] = [];
  for (let index = end; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type === "user") break;
    if (item.type === "assistant" && !item.parentToolCallId && item.text.trim()) parts.unshift(item.text.trim());
  }
  return parts.join("\n\n");
}
