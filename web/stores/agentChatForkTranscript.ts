import type { AgentChatItem } from "@/types/agentChat";
import type { AgentChatSessionState } from "./useAgentChatStore";

type ForkTranscript = Pick<AgentChatSessionState, "items" | "transcriptStart" | "transcriptSessionId">;

/** Seed display history independently from parent permissions, terminals and live usage. */
export function seedForkTranscript(
  child: ForkTranscript,
  items: AgentChatItem[],
  acpSessionId: string,
  preservedPrefixLength: number,
): void {
  // Native fork establishes model context; this copy only supplies the visible transcript.
  if (!child.items.some((item) => item.type !== "notice")) {
    child.items = [...structuredClone(items), ...child.items];
    child.transcriptStart = Math.min(items.length, Math.max(0, preservedPrefixLength));
  } else {
    // A native fork may already have replayed its own transcript before IPC returns.
    child.transcriptStart = 0;
  }
  // Bind the copied history before/after ready alike: later load must replace it,
  // while preserving only the source's explicit older-session prefix.
  child.transcriptSessionId = acpSessionId;
}
