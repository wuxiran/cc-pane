import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./runtime";
import { AgentChatUnavailableError } from "./agentChatService";

export interface UndoAgentFileEdit {
  acpSessionId: string;
  toolCallId: string;
  path: string;
  oldText: string | null;
  newText: string;
}

export function undoAgentFileEdit(chatId: string, edit: UndoAgentFileEdit): Promise<void> {
  if (!isTauriRuntime()) throw new AgentChatUnavailableError();
  return invoke("undo_acp_file_edit", { chatId, edit });
}
