import "@/i18n";
import { beforeEach, describe, expect, it } from "vitest";
import { applyRestoredTranscript } from "./agentChatTranscript";
import { useAgentChatStore } from "./useAgentChatStore";
import { chatEngineTrail, type HandoffNotice } from "./useAgentChatStoreHandoff";

const chatId = "handoff-store";
const notice: HandoffNotice = { type: "notice", id: "handoff-s2", at: 5, text: "x", handoff: { from: "A", to: "B", fromEngineId: "claude", toEngineId: "codex" } };

beforeEach(() => useAgentChatStore.getState().dropChat(chatId));

describe("handoff store slice", () => {
  it("inserts the divider at the prefix boundary without clearing items, once", () => {
    const store = useAgentChatStore.getState();
    store.setSnapshot(chatId, { chatId, engineId: "claude", phase: "ready", acpSessionId: "s1" });
    store.addUserMessage(chatId, "old");
    store.setSnapshot(chatId, { chatId, engineId: "codex", phase: "ready", acpSessionId: "s2" });
    expect(useAgentChatStore.getState().chats[chatId].transcriptStart).toBe(1);
    store.recordHandoff(chatId, { notice, context: "ctx", engineTrail: ["claude", "codex"] });
    store.recordHandoff(chatId, { notice, context: "ctx", engineTrail: ["claude", "codex"] });
    const chat = useAgentChatStore.getState().chats[chatId];
    expect(chat.items.map((item) => item.type)).toEqual(["user", "notice"]);
    expect(chat.transcriptStart).toBe(2);
    expect(chat.pendingHandoff).toEqual({ id: "handoff-s2", text: "ctx" });
    store.clearPendingHandoff(chatId, "other");
    expect(useAgentChatStore.getState().chats[chatId].pendingHandoff).not.toBeNull();
    store.clearPendingHandoff(chatId, "handoff-s2");
    expect(useAgentChatStore.getState().chats[chatId].pendingHandoff).toBeNull();
  });

  it("derives the engine trail from restored handoff dividers", () => {
    const chat = { engineTrail: [], snapshot: { chatId, engineId: "gemini", phase: "ready" as const }, items: [notice,
      { ...notice, id: "h2", handoff: { from: "B", to: "C", fromEngineId: "codex", toEngineId: "gemini" } }] };
    expect(chatEngineTrail(chat)).toEqual(["claude", "codex", "gemini"]);
    expect(chatEngineTrail({ engineTrail: [], items: [], snapshot: chat.snapshot })).toEqual(["gemini"]);
  });

  it("restores an inherited-only segment into a fresh tab after load replay, but not twice", () => {
    const store = useAgentChatStore.getState();
    store.beginHistoryReplay(chatId, "s2");
    store.addUserMessage(chatId, "new engine turn");
    store.finishHistoryReplay(chatId, "s2", true);
    const payload = { fromAcpSessionId: "s2", acpSessionId: "s2", inheritedOnly: true,
      items: [{ type: "user", id: "u", at: 1, text: "old engine turn" }, notice] };
    applyRestoredTranscript(chatId, payload);
    applyRestoredTranscript(chatId, payload);
    const chat = useAgentChatStore.getState().chats[chatId];
    expect(chat.items.map((item) => item.type === "notice" ? (item.handoff ? "handoff" : "head") : item.type === "user" ? item.text : item.type))
      .toEqual(["head", "old engine turn", "handoff", "new engine turn"]);
    expect(chat.transcriptStart).toBe(3);
  });
});
