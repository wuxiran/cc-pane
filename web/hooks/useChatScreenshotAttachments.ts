import { useEffect } from "react";
import { findPane } from "@/lib/paneTree";
import { listenIfTauri } from "@/services/runtime";
import type { ScreenshotResult } from "@/services/screenshotService";
import { usePanesStore } from "@/stores/usePanesStore";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { acquireChatDraft, isChatDraftCurrent } from "@/stores/useAgentChatDraftStore";
import { handleErrorSilent } from "@/utils/errorHandler";
import { attachChatPaths } from "@/components/agentchat/attachChatPaths";

interface ScreenshotStarted { captureId: string }
interface ScreenshotFinished extends ScreenshotStarted { result?: ScreenshotResult | null; error?: string | null }

/** One listener in the main app, independent of mounted/hidden chat composers. */
export function useChatScreenshotAttachments(): void {
  useEffect(() => {
    const captures = new Map<string, { chatId: string; token: number; imageSupported: boolean }>();
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const started = (payload: ScreenshotStarted) => {
      if (disposed || captures.has(payload.captureId)) return;
      const state = usePanesStore.getState();
      const pane = findPane(state.rootPane, state.activePaneId);
      const tab = pane?.type === "panel" ? pane.tabs.find((item) => item.id === pane.activeTabId) : undefined;
      if (tab?.contentType !== "agent-chat") return;
      const caps = useAgentChatStore.getState().chats[tab.id]?.snapshot?.agentCapabilities as
        { promptCapabilities?: { image?: boolean } } | undefined;
      captures.set(payload.captureId, { chatId: tab.id, token: acquireChatDraft(tab.id), imageSupported: caps?.promptCapabilities?.image === true });
    };
    const finished = (payload: ScreenshotFinished) => {
      const target = captures.get(payload.captureId);
      captures.delete(payload.captureId);
      if (disposed || !target || !isChatDraftCurrent(target.chatId, target.token)) return;
      if (payload.error) useAgentChatStore.getState().pushNotice(target.chatId, payload.error);
      if (payload.result?.filePath) {
        void attachChatPaths(target.chatId, target.token, target.imageSupported, [payload.result.filePath]);
      }
    };
    // Arm completion first: a very short capture/cancel must never publish its
    // finish between installing the start listener and installing the finish one.
    void (async () => {
      const finish = await listenIfTauri<ScreenshotFinished>("screenshot-finished", ({ payload }) => finished(payload));
      if (disposed) { finish(); return; }
      unlisteners.push(finish);
      const start = await listenIfTauri<ScreenshotStarted>("screenshot-started", ({ payload }) => started(payload));
      if (disposed) start(); else unlisteners.push(start);
    })().catch((error) => handleErrorSilent(error, "listen for chat screenshot"));
    return () => { disposed = true; captures.clear(); unlisteners.forEach((unlisten) => unlisten()); };
  }, []);
}
