import { describe, expect, it } from "vitest";
import type { AgentChatItem } from "@/types/agentChat";
import { groupChatItems } from "./chatTurns";
import { buildChatTimeline, entryForTurn } from "./chatTimeline";

const conversation: AgentChatItem[] = [
  { type: "user", id: "u1", at: 1, text: "Fix the\nsettings" },
  { type: "thought", id: "t1", at: 2, text: "private reasoning" },
  { type: "tool_call", id: "tool1", at: 3, call: { toolCallId: "tool", title: "Read config" } },
  { type: "assistant", id: "a1", at: 4, text: "Investigating" },
  { type: "notice", id: "n1", at: 5, text: "notice" },
  { type: "assistant", id: "a2", at: 6, text: "Fixed and tested" },
  { type: "user", id: "u2", at: 7, text: "Next task" },
];

describe("conversation timeline entries", () => {
  it("groups each prompt with its latest answer and excludes tools, thoughts and notices", () => {
    const entries = buildChatTimeline(groupChatItems(conversation));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: "u1", title: "Fix the settings", preview: "Fixed and tested", turnIndex: 0 });
    expect(entries[1]).toMatchObject({ id: "u2", preview: "" });
    expect(entryForTurn(entries, 3)).toBe("u1");
    expect(entryForTurn(entries, 4)).toBe("u2");
  });
  it("keeps bookmark identity when history is replayed with new local ids and timestamps", () => {
    const original = buildChatTimeline(groupChatItems(conversation));
    const replay = buildChatTimeline(groupChatItems(conversation.map((item) => ({ ...item, id: `new-${item.id}`, at: 100 }))));
    expect(replay.map((entry) => entry.bookmarkKey)).toEqual(original.map((entry) => entry.bookmarkKey));
  });
  it("distinguishes repeated prompts and keeps keys stable while the response streams", () => {
    const items: AgentChatItem[] = [
      { type: "user", id: "u1", at: 1, text: "Continue" },
      { type: "user", id: "u2", at: 2, text: "Continue" },
    ];
    const before = buildChatTimeline(groupChatItems(items));
    expect(before[0].bookmarkKey).not.toBe(before[1].bookmarkKey);
    const after = buildChatTimeline(groupChatItems([...items, { type: "assistant", id: "a", at: 3, text: "new answer" }]));
    expect(after.map((entry) => entry.bookmarkKey)).toEqual(before.map((entry) => entry.bookmarkKey));
  });
  it("handles attachments, assistant-only history and empty conversations", () => {
    expect(buildChatTimeline([])).toEqual([]);
    const attachment = buildChatTimeline(groupChatItems([{ type: "user", id: "u", at: 1, text: "", attachmentLabels: ["design.png"] }]));
    expect(attachment[0].title).toBe("design.png");
    const assistant = buildChatTimeline(groupChatItems([{ type: "assistant", id: "a", at: 1, text: "Recovered answer" }]));
    expect(assistant[0]).toMatchObject({ id: "a", preview: "Recovered answer" });
  });

  it("keeps attachment-only bookmarks stable when ACP replays content blocks", () => {
    const blocks = [{ type: "image", mimeType: "image/png", data: "AA==" }];
    const original = buildChatTimeline(groupChatItems([{
      type: "user", id: "u", at: 1, text: "", attachmentLabels: ["shot.png"], promptBlocks: blocks,
    }]));
    const replay = buildChatTimeline(groupChatItems([{
      type: "user", id: "new-u", at: 100, text: "", promptBlocks: blocks,
    }]));
    expect(replay[0].bookmarkKey).toBe(original[0].bookmarkKey);
  });

  it("keeps ordinary text bookmarks compatible even when prompt blocks include a preamble", () => {
    const original = buildChatTimeline(groupChatItems([{
      type: "user", id: "u", at: 1, text: "Review this file", promptBlocks: [{ type: "text", text: "Review this file" }],
    }]));
    const replay = buildChatTimeline(groupChatItems([{
      type: "user", id: "new-u", at: 100, text: "Review this file", promptBlocks: [{ type: "text", text: "SYSTEM PREAMBLE\\n---\\nReview this file" }],
    }]));
    expect(replay[0].bookmarkKey).toBe(original[0].bookmarkKey);
  });
});
