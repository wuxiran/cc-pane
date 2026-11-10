// ACP 审批的唯一回应路径：先在 store 占位（防重复点击），发送成功才出队，失败把错误挂回请求。
// 窗格审批卡（ChatPermissionQueue）与灵动岛审批卡（经主窗口事件桥）共用。
import { agentChatService } from "@/services/agentChatService";
import { useAgentChatStore } from "./useAgentChatStore";

export async function respondChatPermission(
  chatId: string,
  requestKey: string,
  optionId: string | null,
): Promise<void> {
  const store = useAgentChatStore.getState();
  if (!store.beginPermissionResponse(chatId, requestKey)) return;
  try {
    await agentChatService.respondPermission(chatId, requestKey, optionId);
    store.finishPermissionResponse(chatId, requestKey);
  } catch (error) {
    store.finishPermissionResponse(
      chatId,
      requestKey,
      error instanceof Error ? error.message : String(error),
    );
  }
}
