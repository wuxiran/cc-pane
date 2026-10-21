import { agentChatService } from "@/services/agentChatService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { isChatDraftCurrent, useAgentChatDraftStore } from "@/stores/useAgentChatDraftStore";
import { baseName, planPathAttachment } from "./chatAttachments";
import { translateError } from "@/utils/errorTranslation";

/** Shared ingestion for dialogs, native drops and captures; the token survives remounts,
 * but closing a chat invalidates any read still in flight. */
export async function attachChatPaths(chatId: string, token: number, imageSupported: boolean, paths: string[]): Promise<void> {
  for (const path of paths) {
    if (!isChatDraftCurrent(chatId, token)) return;
    const name = baseName(path);
    if (planPathAttachment(path, imageSupported) === "file") {
      useAgentChatDraftStore.getState().addAttachments(chatId, token, [
        { name, mimeType: "", data: "", kind: "file", path },
      ]);
      continue;
    }
    try {
      const image = await agentChatService.readImageAttachment(path);
      useAgentChatDraftStore.getState().addAttachments(chatId, token, [
        { name, mimeType: image.mimeType, data: image.dataBase64, kind: "image", path },
      ]);
    } catch (error) {
      if (!isChatDraftCurrent(chatId, token)) return;
      useAgentChatStore.getState().pushNotice(chatId, translateError(error));
    }
  }
}
