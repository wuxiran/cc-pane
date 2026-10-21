import type { AgentChatItem } from "@/types/agentChat";

/** 会话转写 → Markdown（导出用；工具卡只留标题行，diff 太重不进转写）。 */
export function transcriptMarkdown(items: AgentChatItem[]): string {
  const sections: string[] = [];
  for (const item of items) {
    if (item.type === "user") sections.push(`## User\n\n${item.text}`);
    else if (item.type === "assistant") sections.push(`## Assistant\n\n${item.text}`);
    else if (item.type === "thought") sections.push(`> ${item.text.replace(/\n/g, "\n> ")}`);
    else if (item.type === "tool_call") {
      sections.push(`- \`${item.call.kind ?? "tool"}\` ${item.call.title ?? item.call.toolCallId} (${item.call.status ?? "pending"})`);
    } else if (item.type === "plan") {
      sections.push(item.entries.map((entry) => `- [ ] ${entry.content}`).join("\n"));
    }
  }
  return sections.join("\n\n");
}
