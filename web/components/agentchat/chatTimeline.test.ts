import { describe, expect, it } from "vitest";
import type { AcpContentBlock, AgentChatAttachment, AgentChatItem } from "@/types/agentChat";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { groupChatItems } from "./chatTurns";
import { buildChatTimeline, entryForTurn } from "./chatTimeline";
import { buildPromptBlocks } from "./chatPrompt";

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

  it("retains existing plain-text keys when sent and replayed text blocks are available", () => {
    const plain: AgentChatItem = { type: "user", id: "old", at: 1, text: "Continue this task" };
    const sent = { ...plain, promptBlocks: [{ type: "text", text: plain.text }] };
    const replay = { ...plain, id: "new", promptBlocks: [{ type: "text", text: "Continue " }, { type: "text", text: "this task" }] };
    const key = (item: AgentChatItem) => buildChatTimeline(groupChatItems([item]))[0].bookmarkKey;
    expect(key(sent)).toBe(key(plain));
    expect(key(replay)).toBe(key(plain));
  });
  it.each([
    { name: "image-only", text: "", attachments: [{ kind: "image", name: "design.png", data: "AA==", mimeType: "image/png" }] },
    { name: "image and text", text: "Review this picture", attachments: [{ kind: "image", name: "design.png", data: "AA==", mimeType: "image/png" }] },
    { name: "file and mention", text: "Read @other.txt", attachments: [{ kind: "file", name: "report.txt", path: "/project/report.txt" }] },
    { name: "concierge preamble", text: "Review this project", attachments: [], preamble: "Act as the project concierge.\n\n---\n\n" },
  ])("preserves $name bookmark identity through the real history replay store", ({ text, attachments, preamble }) => {
    const chatId = "timeline-replay";
    const store = useAgentChatStore.getState();
    store.dropChat(chatId);
    store.setSnapshot(chatId, { chatId, engineId: "codex", acpSessionId: "same-session", phase: "ready" });
    const blocks = buildPromptBlocks(`${preamble ?? ""}${text}`, attachments as AgentChatAttachment[], "/project");
    store.addUserMessage(chatId, text, attachments as AgentChatAttachment[], blocks);
    const before = buildChatTimeline(groupChatItems(useAgentChatStore.getState().chats[chatId].items))[0];
    store.beginHistoryReplay(chatId, "same-session");
    for (const block of blocks) {
      // Adapters may add metadata or deliver one text block in multiple chunks.
      const replayBlocks: AcpContentBlock[] = block.type === "text"
        ? [{ type: "text", text: block.text!.slice(0, 3) }, { type: "text", text: block.text!.slice(3) }]
        : [{ ...block, _meta: { volatileRequestId: "changed" }, annotations: { audience: ["user"] } }];
      for (const content of replayBlocks) store.applySessionUpdate(chatId, { update: { sessionUpdate: "user_message_chunk", content } });
    }
    store.finishHistoryReplay(chatId, "same-session", true);
    const after = buildChatTimeline(groupChatItems(useAgentChatStore.getState().chats[chatId].items))[0];
    expect(after.id).not.toBe(before.id);
    expect(after.bookmarkKey).toBe(before.bookmarkKey);
    store.dropChat(chatId);
  });
});
