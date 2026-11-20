// 会话索引条目的展示文字：搜索面板和右侧「终端会话」列表共用一套取标题的规则。
import type { SessionIndexEntry } from "@/types/sessionIndex";

/** 取第一行可读文字：去掉 <local-command-caveat> 之类的标记和 Markdown 标题符号。 */
export function readableLine(text: string | undefined | null): string {
  if (!text) return "";
  for (const line of text.replace(/<[^>\n]*>?/g, " ").split(/\r?\n/)) {
    const cleaned = line.replace(/^#+\s*/, "").trim();
    if (cleaned) return cleaned;
  }
  return "";
}

/** 会话标题：CLI 自带标题 > 首条输入的第一行 > 最近进展的第一行；都读不出返回空串。 */
export function sessionEntryTitle(entry: SessionIndexEntry): string {
  return entry.title?.trim() || readableLine(entry.firstPrompt) || readableLine(entry.lastSummary);
}
