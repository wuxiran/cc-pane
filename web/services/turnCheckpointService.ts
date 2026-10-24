import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./runtime";
import { AgentChatUnavailableError } from "./agentChatService";
import type { RestoreTurnCheckpointResult, TurnCheckpointRecord, TurnCheckpointReview } from "@/types/turnCheckpoint";

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) throw new AgentChatUnavailableError();
  return invoke<T>(command, args);
}

export const turnCheckpointService = {
  cliChatId(sessionId: string): string {
    return `cli:${sessionId}`;
  },
  beginCli(sessionId: string): Promise<TurnCheckpointRecord> {
    return call("begin_cli_turn_checkpoint", { sessionId });
  },
  finishCli(sessionId: string, id: string): Promise<TurnCheckpointRecord> {
    return call("finish_cli_turn_checkpoint", { sessionId, id });
  },
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
