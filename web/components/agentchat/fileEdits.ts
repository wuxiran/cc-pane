import type { AcpToolCall, AcpToolCallContent } from "@/types/agentChat";

export interface FileEditBlock extends AcpToolCallContent {
  type: "diff";
  path: string;
  oldText: string | null;
  newText: string;
}

/** Only reported successful diffs become file cards; titles and prose are not evidence. */
export function completedFileEdits(call: AcpToolCall): FileEditBlock[] {
  if (call.status !== "completed") return [];
  return (call.content ?? []).filter((block): block is FileEditBlock =>
    block.type === "diff" && typeof block.path === "string" && block.path.length > 0
    && typeof block.newText === "string" && (typeof block.oldText === "string" || block.oldText === null)
    && block.oldText !== block.newText,
  );
}

export function canUndoFileEdit(block: FileEditBlock, siblings: FileEditBlock[]): boolean {
  if ((typeof block.oldText !== "string" && block.oldText !== null) || block.path.length > 4096 || siblings.filter((other) => other.path === block.path).length !== 1) return false;
  const encoder = new TextEncoder();
  return !(block.oldText?.includes("\0") ?? false) && !block.newText.includes("\0")
    && encoder.encode(block.oldText ?? "").length <= 1024 * 1024
    && encoder.encode(block.newText).length <= 1024 * 1024;
}
