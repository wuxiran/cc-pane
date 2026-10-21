import { agentChatService } from "@/services/agentChatService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import type { AcpElicitationResponse } from "@/types/agentChat";
import QuestionCard from "./QuestionCard";
import { translateError } from "@/utils/errorTranslation";

/** Drafts and in-flight responses survive tab remounts; only successful writes dequeue. */
export default function ChatQuestionQueue({ chatId }: { chatId: string }) {
  const request = useAgentChatStore((state) => state.chats[chatId]?.pendingElicitations[0]);
  if (!request) return null;
  const respond = async (response: AcpElicitationResponse) => {
    const store = useAgentChatStore.getState();
    if (!store.beginElicitationResponse(chatId, request.requestKey)) return;
    try {
      await agentChatService.respondElicitation(chatId, request.requestKey, response);
      store.finishElicitationResponse(chatId, request.requestKey);
    } catch (error) {
      store.finishElicitationResponse(chatId, request.requestKey, translateError(error));
    }
  };
  return <div className="px-3 pb-3"><QuestionCard
    key={request.requestKey} request={request} values={request.values}
    onChange={(values) => useAgentChatStore.getState().setElicitationValues(chatId, request.requestKey, values)}
    onRespond={(response) => void respond(response)} responding={request.responding} error={request.error}
  /></div>;
}
