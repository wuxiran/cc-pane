import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./runtime";
import { AgentChatUnavailableError } from "./agentChatService";
import type { AcpRunEventPage, AcpRunPage, AcpRunQuery } from "@/types/agentRuntime";

async function read<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) throw new AgentChatUnavailableError();
  return invoke<T>(command, args);
}

/** Durable local records only. Reading never starts or resumes an agent. */
export const agentRuntimeService = {
  list(query: AcpRunQuery = {}): Promise<AcpRunPage> {
    return read("list_acp_run_records", { ...query });
  },
  events(runId: string, afterSeq?: number): Promise<AcpRunEventPage> {
    return read("read_acp_run_events", { runId, afterSeq });
  },
};
