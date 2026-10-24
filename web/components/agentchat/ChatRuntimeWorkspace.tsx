import { createContext, Suspense, useContext, useEffect, useState, type ReactNode } from "react";
import { lazyWithRetry } from "@/lib/lazyRetry";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import { residentAgentChatCwd } from "./chatPaths";
import { useAgentChatStore } from "@/stores/useAgentChatStore";

const ChatRunHistoryPanel = lazyWithRetry(() => import("./ChatRunHistoryPanel"), "ChatRunHistoryPanel");
const TurnCheckpointPanel = lazyWithRetry(() => import("./TurnCheckpointPanel"), "TurnCheckpointPanel");
const SessionReviewPanel = lazyWithRetry(() => import("@/components/review/SessionReviewPanel"), "SessionReviewPanel");
const RuntimeToolsContext = createContext<{ openHistory: () => void; openCheckpoints: () => void; openReview: (cwd?: string) => void } | null>(null);

export function useChatRuntimeTools() {
  return useContext(RuntimeToolsContext);
}

/** Tools remain available after process exit and before a new engine is started. */
export default function ChatRuntimeWorkspace({ chatId, cwd, children }: { chatId: string; cwd?: string; children: ReactNode }) {
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const [reviewPath, setReviewPath] = useState<string | null>(null);
  const cwdOverride = useAgentChatStore((state) => state.chats[chatId]?.cwdOverride);
  const [checkpointTarget, setCheckpointTarget] = useState<{ chatId: string; checkpointId?: string } | null>(null);
  const snapshot = useAgentChatStore((state) => state.chats[chatId]?.snapshot);
  const pending = useAgentChatStore((state) => Boolean(state.chats[chatId]?.pendingPrompt || state.chats[chatId]?.setup?.pending));
  const targetBusy = useAgentChatStore((state) => {
    const target = checkpointTarget && state.chats[checkpointTarget.chatId];
    return Boolean(target?.snapshot?.phase === "generating" || target?.pendingPrompt || target?.setup?.pending);
  });
  const [historyOpen, setHistoryOpen] = useState(false);
  useEffect(() => { setHistoryOpen(false); setCheckpointTarget(null); setReviewPath(null); }, [chatId]);
  const openCheckpoint = (sourceChatId: string, checkpointId?: string) => {
    setHistoryOpen(false);
    setCheckpointTarget({ chatId: sourceChatId, checkpointId });
  };
  return <RuntimeToolsContext.Provider value={{
    openHistory: () => { setReviewPath(null); setCheckpointTarget(null); setHistoryOpen(true); },
    openCheckpoints: () => { setReviewPath(null); openCheckpoint(chatId); },
    openReview: (path) => { setHistoryOpen(false); setCheckpointTarget(null); setReviewPath(path || cwdOverride || cwd || residentAgentChatCwd(workspaces)); },
  }}>
    {children}
    <Suspense fallback={null}>
      {reviewPath !== null && <SessionReviewPanel key={`${chatId}:${reviewPath}`} projectPath={reviewPath} checkpointChatId={chatId} open onOpenChange={(value) => { if (!value) setReviewPath(null); }} />}
      {historyOpen && <ChatRunHistoryPanel key={chatId} chatId={chatId} engineId={snapshot?.engineId} acpSessionId={snapshot?.acpSessionId} open onOpenChange={setHistoryOpen} onOpenCheckpoint={openCheckpoint} />}
      {checkpointTarget && <TurnCheckpointPanel key={`${chatId}:${checkpointTarget.chatId}:${checkpointTarget.checkpointId ?? ""}`}
        chatId={checkpointTarget.chatId} initialCheckpointId={checkpointTarget.checkpointId} open
        onOpenChange={(open) => { if (!open) setCheckpointTarget(null); }} generating={snapshot?.phase === "generating" || pending || targetBusy} />}
    </Suspense>
  </RuntimeToolsContext.Provider>;
}
