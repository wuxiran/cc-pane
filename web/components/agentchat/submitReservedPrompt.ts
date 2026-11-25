import type { AcpContentBlock } from "@/types/agentChat";
import { agentChatService } from "@/services/agentChatService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";

/** 调用方同步 beginPrompt 抢占后才清草稿；此处统一确认或撤回乐观气泡。
 * 换引擎交接后的第一条消息：交接上下文作为前置 text block 只发给 agent
 * （气泡与重试用的 promptBlocks 不含它），发送成功后清除，只带一次。 */
export async function submitReservedPrompt(chatId: string, token: number, blocks: AcpContentBlock[]): Promise<void> {
  const handoff = useAgentChatStore.getState().chats[chatId]?.pendingHandoff ?? null;
  const outbound = handoff ? [{ type: "text", text: handoff.text }, ...blocks] : blocks;
  try {
    await agentChatService.prompt(chatId, outbound);
    if (handoff) useAgentChatStore.getState().clearPendingHandoff(chatId, handoff.id);
    useAgentChatStore.getState().finishPrompt(chatId, token);
  } catch (error) {
    useAgentChatStore.getState().finishPrompt(chatId, token, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
