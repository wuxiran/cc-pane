import { createContext, Suspense, useContext, useEffect, useState, type ReactNode } from "react";
import { lazyWithRetry } from "@/lib/lazyRetry";
import { useAgentChatStore } from "@/stores/useAgentChatStore";

const ChatRunHistoryPanel = lazyWithRetry(() => import("./ChatRunHistoryPanel"), "ChatRunHistoryPanel");
const TurnCheckpointPanel = lazyWithRetry(() => import("./TurnCheckpointPanel"), "TurnCheckpointPanel");
const RuntimeToolsContext = createContext<{ openHistory: () => void; openCheckpoints: () => void } | null>(null);

export function useChatRuntimeTools() {
  return useContext(RuntimeToolsContext);
}

/** Tools remain available after process exit and before a new engine is started. */
export default function ChatRuntimeWorkspace({ chatId, children }: { chatId: string; children: ReactNode }) {
  const [checkpointTarget, setCheckpointTarget] = useState<{ chatId: string; checkpointId?: string } | null>(null);
  const snapshot = useAgentChatStore((state) => state.chats[chatId]?.snapshot);
  const pending = useAgentChatStore((state) => Boolean(state.chats[chatId]?.pendingPrompt || state.chats[chatId]?.setup?.pending));
  const targetBusy = useAgentChatStore((state) => {
    const target = checkpointTarget && state.chats[checkpointTarget.chatId];
    return Boolean(target?.snapshot?.phase === "generating" || target?.pendingPrompt || target?.setup?.pending);
  });
  const [historyOpen, setHistoryOpen] = useState(false);
  useEffect(() => { setHistoryOpen(false); setCheckpointTarget(null); }, [chatId]);
  const openCheckpoint = (sourceChatId: string, checkpointId?: string) => {
    setHistoryOpen(false);
    setCheckpointTarget({ chatId: sourceChatId, checkpointId });
  };
  return <RuntimeToolsContext.Provider value={{
    openHistory: () => { setCheckpointTarget(null); setHistoryOpen(true); },
    openCheckpoints: () => openCheckpoint(chatId),
  }}>
    {children}
    <Suspense fallback={null}>
      {historyOpen && <ChatRunHistoryPanel key={chatId} chatId={chatId} engineId={snapshot?.engineId} acpSessionId={snapshot?.acpSessionId} open onOpenChange={setHistoryOpen} onOpenCheckpoint={openCheckpoint} />}
      {checkpointTarget && <TurnCheckpointPanel key={`${chatId}:${checkpointTarget.chatId}:${checkpointTarget.checkpointId ?? ""}`}
        chatId={checkpointTarget.chatId} initialCheckpointId={checkpointTarget.checkpointId} open
        onOpenChange={(open) => { if (!open) setCheckpointTarget(null); }} generating={snapshot?.phase === "generating" || pending || targetBusy} />}
    </Suspense>
  </RuntimeToolsContext.Provider>;
}
