import { agentChatService } from "@/services/agentChatService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import PermissionCard from "./PermissionCard";

/** 请求按到达顺序逐项处理；发送成功才出队，切标签也不丢在途状态。 */
export default function ChatPermissionQueue({ chatId }: { chatId: string }) {
  const request = useAgentChatStore((state) => state.chats[chatId]?.pendingPermissions[0]);
  if (!request) return null;
  const respond = async (optionId: string | null) => {
    const store = useAgentChatStore.getState();
    if (!store.beginPermissionResponse(chatId, request.requestKey)) return;
    try {
      await agentChatService.respondPermission(chatId, request.requestKey, optionId);
      store.finishPermissionResponse(chatId, request.requestKey);
    } catch (error) {
      store.finishPermissionResponse(
        chatId,
        request.requestKey,
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  return (
    <PermissionCard
      request={request}
      responding={request.responding}
      error={request.error}
      onRespond={(optionId) => void respond(optionId)}
    />
  );
}
