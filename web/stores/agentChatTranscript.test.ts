import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { agentChatService } from "@/services/agentChatService";
import type { AcpChatEvent, AgentChatItem } from "@/types/agentChat";
import { dropAgentChatState, ensureAgentChatListener } from "./agentChatEvents";
import { MAX_PERSISTED_IMAGE_CHARS, sanitizeTranscriptItems } from "./agentChatTranscript";
import { useAgentChatStore } from "./useAgentChatStore";

vi.mock("@/services/agentChatService", () => ({
  agentChatService: { listen: vi.fn(), saveTranscript: vi.fn(async () => {}) },
}));

const CHAT = "transcript-test";
let dispatch!: (event: AcpChatEvent) => void;
const emit = (kind: string, payload: unknown) => dispatch({ chatId: CHAT, kind, payload });
const state = (phase: "starting" | "ready" | "exited", acpSessionId?: string) =>
  emit("state", { chatId: CHAT, engineId: "grok", phase, acpSessionId });
const chat = () => useAgentChatStore.getState().chats[CHAT];
const texts = () => chat().items.map((item) => ("text" in item ? item.text : item.type));
const saved = () => vi.mocked(agentChatService.saveTranscript).mock.calls;
const t = (key: string): string => i18n.t(key as never, { ns: "notifications" });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const oldItems: AgentChatItem[] = [
  { type: "user", id: "u1", at: 1, text: "old question" },
  { type: "assistant", id: "a1", at: 2, text: "old answer" },
  { type: "plan", id: "p1", at: 3, entries: [{ content: "old step", status: "completed", priority: "medium" }] },
];
const restorePayload = (truncated = false) => ({
  fromAcpSessionId: "old-session",
  acpSessionId: "new-session",
  truncated,
  items: oldItems,
});

beforeAll(() => {
  vi.mocked(agentChatService.listen).mockImplementation(async (handler) => {
    dispatch = handler;
    return () => {};
  });
  ensureAgentChatListener();
});
afterEach(async () => {
  dropAgentChatState(CHAT);
  await flush();
  vi.mocked(agentChatService.saveTranscript).mockClear();
});

describe("agent chat transcript persistence", () => {
  it("persists only the current session body after a turn ends", async () => {
    state("ready", "s1");
    useAgentChatStore.getState().addUserMessage(CHAT, "hello", [
      { name: "a.png", mimeType: "image/png", data: "AAAA", kind: "image" },
    ], [{ type: "text", text: "hello" }]);
    emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi there" } } });
    emit("turn_ended", { stopReason: "end_turn" });
    await flush();
    expect(saved()).toHaveLength(1);
    const [sessionId, items] = saved()[0];
    expect(sessionId).toBe("s1");
    expect(items.map((item) => item.type)).toEqual(["user", "assistant"]);
    const user = items[0] as Extract<AgentChatItem, { type: "user" }>;
    expect(user.attachments).toBeUndefined();
    expect(user.promptBlocks).toBeUndefined();
    expect(user.attachmentLabels).toEqual(["a.png"]);
  });

  it("does not save notice-only sessions or sessions without an id", async () => {
    state("starting");
    useAgentChatStore.getState().addUserMessage(CHAT, "before ready");
    emit("turn_ended", { stopReason: "end_turn" });
    state("ready", "s1");
    useAgentChatStore.getState().pushNotice(CHAT, "only a notice");
    emit("turn_ended", { stopReason: "end_turn" });
    await flush();
    expect(saved()).toHaveLength(0);
  });

  it("saves on exit and on tab close", async () => {
    state("ready", "s1");
    useAgentChatStore.getState().addUserMessage(CHAT, "q");
    state("exited", "s1");
    emit("update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } } });
    dropAgentChatState(CHAT);
    await flush();
    expect(saved()).toHaveLength(2);
    expect(saved()[1][1].map((item) => item.type)).toEqual(["user", "assistant"]);
  });

  it("drops oversized inline images but keeps small ones", () => {
    const items = sanitizeTranscriptItems([
      { type: "image", id: "big", at: 1, mimeType: "image/png", data: "x".repeat(MAX_PERSISTED_IMAGE_CHARS + 1) },
      { type: "image", id: "small", at: 2, mimeType: "image/png", data: "xx" },
    ]);
    expect(items.map((item) => item.type)).toEqual(["notice", "image"]);
  });
});

describe("agent chat transcript restore", () => {
  it("restores the old transcript read-only between dividers before ready", () => {
    state("starting");
    emit("transcript_restore", restorePayload());
    state("ready", "new-session");
    const items = chat().items;
    expect(texts()).toEqual([
      t("agentChat.restoredTranscriptHeader"), "old question", "old answer", "plan", t("agentChat.restoredTranscriptFooter"),
    ]);
    expect(items[0]).toMatchObject({ type: "notice", divider: true });
    expect(chat().transcriptStart).toBe(items.length);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });

  it("keeps restored items in the prefix when ready arrives first, and new plans do not overwrite them", async () => {
    state("ready", "new-session");
    useAgentChatStore.getState().pushNotice(CHAT, "live notice");
    emit("transcript_restore", restorePayload(true));
    expect(texts()[0]).toBe(t("agentChat.restoredTranscriptHeaderTruncated"));
    expect(texts()[texts().length - 1]).toBe("live notice");
    expect(chat().transcriptStart).toBe(5);

    emit("update", { update: { sessionUpdate: "plan", entries: [{ content: "new step", status: "pending", priority: "high" }] } });
    const plans = chat().items.filter((item) => item.type === "plan");
    expect(plans).toHaveLength(2);
    expect(plans[0].entries[0].content).toBe("old step");

    useAgentChatStore.getState().addUserMessage(CHAT, "new question");
    emit("turn_ended", { stopReason: "end_turn" });
    await flush();
    // 恢复段由后端作为 inherited 保存；前端只交新会话正文。
    expect(saved()[0][1].map((item) => ("text" in item ? item.text : item.type))).toEqual(["live notice", "plan", "new question"]);
  });

  it("is idempotent and skips when the same tab still shows the old session", () => {
    state("ready", "old-session");
    useAgentChatStore.getState().addUserMessage(CHAT, "still visible");
    emit("transcript_restore", restorePayload());
    expect(texts()).toEqual(["still visible"]);

    dropAgentChatState(CHAT);
    emit("transcript_restore", restorePayload());
    emit("transcript_restore", restorePayload());
    expect(chat().items.filter((item) => item.type === "notice" && item.divider)).toHaveLength(2);
  });

  it("ignores malformed payloads and degrades omitted images", () => {
    emit("transcript_restore", null);
    emit("transcript_restore", { fromAcpSessionId: "a", acpSessionId: "b", items: [] });
    expect(chat()).toBeUndefined();
    emit("transcript_restore", {
      fromAcpSessionId: "a",
      acpSessionId: "b",
      items: [{ type: "bogus", at: 1 }, { type: "image", id: "i", at: 1, mimeType: "image/png", dataOmitted: true }],
    });
    expect(texts()).toEqual([
      t("agentChat.restoredTranscriptHeader"), t("agentChat.transcriptImageOmitted"), t("agentChat.restoredTranscriptFooter"),
    ]);
  });
});
