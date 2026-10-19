import type { AcpContentBlock } from "@/types/agentChat";
import { agentChatService } from "@/services/agentChatService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";

/** 调用方同步 beginPrompt 抢占后才清草稿；此处统一确认或撤回乐观气泡。 */
export async function submitReservedPrompt(chatId: string, token: number, blocks: AcpContentBlock[]): Promise<void> {
  try {
    await agentChatService.prompt(chatId, blocks);
    useAgentChatStore.getState().finishPrompt(chatId, token);
  } catch (error) {
    useAgentChatStore.getState().finishPrompt(chatId, token, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
