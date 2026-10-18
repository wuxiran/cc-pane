import type { ChatTurn } from "./chatTurns";
import type { AcpContentBlock } from "@/types/agentChat";

export interface ChatTimelineEntry {
  id: string;
  turnIndex: number;
  bookmarkKey: string;
  title: string;
  preview: string;
  at: number;
}

const excerpt = (text: string, limit: number) => text.replace(/\s+/g, " ").trim().slice(0, limit);

// Item ids are generated again when ACP replays a conversation. Bookmark identity
// therefore uses the prompt plus its occurrence, never a volatile item id/time.
function fingerprint(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** Attachment-only turns have no visible text after ACP replay. Use their wire
 * blocks for identity; keep the historical text/label identity untouched. */
function attachmentIdentity(blocks: readonly AcpContentBlock[]): string {
  return JSON.stringify(blocks.map((block) => {
    if (block.type === "image") return { type: block.type, mimeType: block.mimeType, data: block.data };
    if (block.type === "resource_link") return { type: block.type, uri: block.uri, name: block.name };
    return { type: block.type, text: block.text };
  }));
}

export function buildChatTimeline(turns: readonly ChatTurn[]): ChatTimelineEntry[] {
  const entries: ChatTimelineEntry[] = [];
  const occurrences = new Map<string, number>();
  for (const [turnIndex, turn] of turns.entries()) {
    if (turn.kind === "notice") continue;
    if (turn.kind === "user" || entries.length === 0) {
      const title = turn.kind === "user"
        ? turn.item.text || (turn.item.attachmentLabels ?? []).join(", ")
        : "";
      // Preserve the pre-existing text/label key format for ordinary turns so
      // persisted bookmarks remain valid across this migration.
      const identityText = turn.kind === "user" && !turn.item.text && turn.item.promptBlocks?.length
        ? `attachment:${attachmentIdentity(turn.item.promptBlocks)}`
        : title;
      const identity = `${turn.kind}:${fingerprint(identityText)}`;
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      entries.push({
        id: turn.id, turnIndex, title: excerpt(title, 180), preview: "", at: turn.at,
        bookmarkKey: `${identity}:${occurrence}`,
      });
    }
    if (turn.kind === "assistant") {
      // Prefer the latest top-level answer; tool output and hidden reasoning do
      // not belong in the compact conversation preview.
      const text = turn.blocks.filter((block) => block.kind === "text").slice(-1)[0];
      if (text?.kind === "text") entries[entries.length - 1].preview = excerpt(text.item.text, 280);
    }
  }
  return entries;
}

export function entryForTurn(entries: readonly ChatTimelineEntry[], turnIndex: number): string | null {
  let id: string | null = entries[0]?.id ?? null;
  for (const entry of entries) {
    if (entry.turnIndex > turnIndex) break;
    id = entry.id;
  }
  return id;
}
