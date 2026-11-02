import type { Tab } from "@/types";
import { collectPanels } from "@/lib/paneTree";
import { projectedLayouts } from "@/stores/panes/layoutLifecycle";
import { usePanesStore } from "@/stores/usePanesStore";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { acquireChatDraft, isChatDraftCurrent, useAgentChatDraftStore } from "@/stores/useAgentChatDraftStore";
import { baseName, planPathAttachment } from "@/components/agentchat/chatAttachments";
import { agentChatService } from "@/services/agentChatService";
import type { AgentChatAttachment } from "@/types/agentChat";
import type { SavedAnnotation } from "@/services/browserAnnotationService";

export function annotationChatTargets(state: Parameters<typeof projectedLayouts>[0]): Tab[] {
  const unique = new Map<string, Tab>();
  for (const layout of projectedLayouts(state)) for (const pane of collectPanels(layout.rootPane)) for (const tab of pane.tabs) {
    if (tab.contentType === "agent-chat") unique.set(tab.id, tab);
  }
  return [...unique.values()];
}
export async function addAnnotationToDraft(chatId: string, saved: SavedAnnotation): Promise<void> {
  const chat = useAgentChatStore.getState().chats[chatId];
  const available = () => annotationChatTargets(usePanesStore.getState()).some((tab) => tab.id === chatId);
  if (!available() || !chat?.snapshot) {
    throw new Error("The selected Agent session is no longer available");
  }
  const sessionId = chat.snapshot.acpSessionId;
  const engineId = chat.snapshot.engineId;
  const token = acquireChatDraft(chatId);
  const caps = chat.snapshot.agentCapabilities as { promptCapabilities?: { image?: boolean } } | undefined;
  const attachment: AgentChatAttachment = { name: baseName(saved.filePath), mimeType: "", data: "", kind: "file", path: saved.filePath };
  // Unlike generic multi-file ingestion, this single handoff must fail if its image cannot be read.
  if (planPathAttachment(saved.filePath, caps?.promptCapabilities?.image === true) === "image") {
    const image = await agentChatService.readImageAttachment(saved.filePath);
    Object.assign(attachment, { kind: "image", mimeType: image.mimeType, data: image.dataBase64 });
  }
  const assertCurrent = () => {
    const current = useAgentChatStore.getState().chats[chatId]?.snapshot;
    if (!isChatDraftCurrent(chatId, token) || !available() || !current || current.acpSessionId !== sessionId || current.engineId !== engineId) {
      throw new Error("The selected Agent session was closed or changed");
    }
  };
  assertCurrent();
  useAgentChatDraftStore.getState().addAttachments(chatId, token, [attachment]);
  useAgentChatDraftStore.getState().appendText(chatId, token, `\n\n${saved.markdown}`);
  assertCurrent();
}
