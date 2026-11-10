import { respondChatPermission } from "@/stores/agentChatPermissionResponse";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import PermissionCard from "./PermissionCard";

/** 请求按到达顺序逐项处理；发送成功才出队，切标签也不丢在途状态。 */
export default function ChatPermissionQueue({ chatId }: { chatId: string }) {
  const request = useAgentChatStore((state) => state.chats[chatId]?.pendingPermissions[0]);
  if (!request) return null;
  return (
    <PermissionCard
      request={request}
      responding={request.responding}
      error={request.error}
      onRespond={(optionId) => void respondChatPermission(chatId, request.requestKey, optionId)}
    />
  );
}
