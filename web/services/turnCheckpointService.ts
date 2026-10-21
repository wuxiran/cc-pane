import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./runtime";
import { AgentChatUnavailableError } from "./agentChatService";
import type { RestoreTurnCheckpointResult, TurnCheckpointRecord, TurnCheckpointReview } from "@/types/turnCheckpoint";

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) throw new AgentChatUnavailableError();
  return invoke<T>(command, args);
}

export const turnCheckpointService = {
  list(chatId: string): Promise<TurnCheckpointRecord[]> {
    return call("list_turn_checkpoints", { chatId });
  },
  review(id: string): Promise<TurnCheckpointReview> {
    return call("review_turn_checkpoint", { id });
  },
  restore(id: string, revision: string): Promise<RestoreTurnCheckpointResult> {
    return call("restore_turn_checkpoint", { id, revision });
  },
};
