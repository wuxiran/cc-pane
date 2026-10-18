import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentChatService } from "@/services/agentChatService";
import type { AcpChatEvent } from "@/types/agentChat";
import { ensureAgentChatListener, dropAgentChatState } from "./agentChatEvents";
import { useAgentChatStore } from "./useAgentChatStore";

vi.mock("@/services/agentChatService", () => ({ agentChatService: { listen: vi.fn() } }));
let dispatch!: (event: AcpChatEvent) => void;
const CHAT = "replay-test";
const emit = (kind: string, payload: unknown) => dispatch({ chatId: CHAT, kind, payload });
const state = (phase: "starting" | "ready" | "failed" | "exited", sessionId = "session-a") => emit("state", { chatId: CHAT, engineId: "claude", phase, acpSessionId: sessionId });
const replay = (phase: "begin" | "commit" | "abort", acpSessionId = "session-a") => emit("history_replay", { phase, acpSessionId });
const chunk = (sessionUpdate: string, text: string) => emit("update", { update: { sessionUpdate, content: { type: "text", text } } });
const messages = () => useAgentChatStore.getState().chats[CHAT].items.map((item) => "text" in item ? item.text : item.type);
beforeAll(() => {
  vi.mocked(agentChatService.listen).mockImplementation(async (handler) => { dispatch = handler; return () => {}; });
  ensureAgentChatListener();
});
beforeEach(() => {
  vi.useFakeTimers();
  state("ready");
  useAgentChatStore.getState().addUserMessage(CHAT, "question-a");
  useAgentChatStore.getState().appendStreamText(CHAT, "assistant", "answer-a");
});
afterEach(() => { dropAgentChatState(CHAT); vi.runOnlyPendingTimers(); vi.useRealTimers(); });

describe("history replay event transaction", () => {
  it("replaces a successful replay and flushes the final buffered token before commit", () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      state("starting"); replay("begin");
      chunk("user_message_chunk", "question-a");
      chunk("agent_message_chunk", "answer-");
      chunk("agent_message_chunk", "a");
      expect(messages()).toEqual(["question-a", "answer-a"]);
      replay("commit"); state("ready");
      expect(messages()).toEqual(["question-a", "answer-a"]);
      expect(useAgentChatStore.getState().chats[CHAT].replay).toBeNull();
    }
  });

  it.each(["abort", "failed", "exited"] as const)("keeps old history when replay ends with %s", (ending) => {
    state("starting"); replay("begin");
    chunk("user_message_chunk", "partial-history");
    chunk("agent_message_chunk", "partial-answer");
    if (ending === "abort") replay("abort"); else state(ending);
    expect(messages()).toEqual(["question-a", "answer-a"]);
    expect(useAgentChatStore.getState().chats[CHAT].replay).toBeNull();
    // An already-aborted late boundary cannot erase the retained transcript.
    replay("commit");
    expect(messages()).toEqual(["question-a", "answer-a"]);
  });

  it("preserves prior-project history when replacing only the current conversation", () => {
    state("starting", "session-b"); state("ready", "session-b");
    const store = useAgentChatStore.getState();
    store.pushNotice(CHAT, "switched to project-b"); store.preserveTranscriptPrefix(CHAT);
    store.addUserMessage(CHAT, "question-b"); store.appendStreamText(CHAT, "assistant", "answer-b");
    state("starting", "session-b"); replay("begin", "session-b");
    chunk("user_message_chunk", "question-b"); chunk("agent_message_chunk", "answer-b");
    replay("commit", "session-b"); state("ready", "session-b");
    expect(messages()).toEqual(["question-a", "answer-a", "switched to project-b", "question-b", "answer-b"]);
  });

  it("discards failed replay fragments before showing the fallback-to-new notice", () => {
    state("starting"); replay("begin"); chunk("agent_message_chunk", "partial"); replay("abort");
    emit("notification", { method: "ccpanes/load-failed" }); state("ready", "replacement-session");
    expect(messages().slice(0, 2)).toEqual(["question-a", "answer-a"]);
    expect(messages()).toHaveLength(3);
    expect(messages()).not.toContain("partial");
  });

  it("buffers tools, images and terminal output and restores complete user blocks", () => {
    state("starting"); replay("begin");
    const image = { type: "image", data: "AA==", mimeType: "image/png" };
    emit("update", { update: { sessionUpdate: "user_message_chunk", content: image } });
    emit("update", { update: { sessionUpdate: "tool_call", toolCallId: "tool", status: "pending", content: [{ type: "terminal", terminalId: "terminal" }] } });
    emit("terminal_output", { terminalId: "terminal", output: "output", truncated: false });
    emit("update", { update: { sessionUpdate: "tool_call_update", toolCallId: "tool", status: "completed" } });
    emit("update", { update: { sessionUpdate: "agent_message_chunk", content: image } });
    expect(messages()).toEqual(["question-a", "answer-a"]);
    replay("commit");
    const chat = useAgentChatStore.getState().chats[CHAT];
    expect(chat.items.map((item) => item.type)).toEqual(["user", "tool_call", "image"]);
    expect(chat.items[0].type === "user" && chat.items[0].promptBlocks).toEqual([image]);
    expect(chat.items[1].type === "tool_call" && chat.items[1].call.status).toBe("completed");
    expect(chat.terminals.terminal.output).toBe("output");
  });
});
