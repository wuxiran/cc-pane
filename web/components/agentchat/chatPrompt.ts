import type { AcpContentBlock, AgentChatAttachment } from "@/types/agentChat";
import { isAbsolutePath, joinCwd, toFileUri } from "./chatPaths";

/** 发送和兼容旧消息的重试共用；新消息直接保留原始 blocks，重试不重新解释路径。
 * `excludedMentions`：命中 Bot / 引擎的 `@token`，不是文件，不转 resource_link。 */
export function buildPromptBlocks(
  text: string,
  attachments: readonly AgentChatAttachment[],
  cwd: string,
  excludedMentions?: ReadonlySet<string>,
): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = attachments.map((attachment) =>
    attachment.kind === "file" && attachment.path
      ? { type: "resource_link", uri: toFileUri(attachment.path), name: attachment.name }
      : { type: "image", mimeType: attachment.mimeType, data: attachment.data },
  );
  for (const match of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const mention = match[1];
    if (excludedMentions?.has(mention)) continue;
    const absolute = isAbsolutePath(mention) ? mention : joinCwd(cwd || ".", mention);
    blocks.push({ type: "resource_link", uri: toFileUri(absolute), name: mention });
  }
  if (text) blocks.push({ type: "text", text });
  return blocks;
}
