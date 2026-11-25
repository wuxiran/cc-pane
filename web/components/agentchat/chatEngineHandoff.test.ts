import "@/i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpChatSnapshot, AgentChatItem } from "@/types/agentChat";
import { agentChatService } from "@/services/agentChatService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { chatEngineTrail } from "@/stores/useAgentChatStoreHandoff";
import { canSwitchEngine, handoffTargets, snapshotModelLabel, switchChatEngine } from "./chatEngineHandoff";
import { submitReservedPrompt } from "./submitReservedPrompt";

vi.mock("@/services/agentChatService", () => ({ agentChatService: {
  start: vi.fn(), get: vi.fn(), setMode: vi.fn(), setModel: vi.fn(), setConfigOption: vi.fn(), prompt: vi.fn(), saveTranscript: vi.fn(),
} }));

const chatId = "handoff-chat";
const claude: AcpChatSnapshot = {
  chatId, engineId: "claude", phase: "ready", acpSessionId: "old-session",
  models: { currentModelId: "sonnet", availableModels: [{ modelId: "sonnet", name: "Sonnet" }] },
};
const codex: AcpChatSnapshot = { chatId, engineId: "codex", phase: "ready", acpSessionId: "new-session" };
const oldItems: AgentChatItem[] = [
  { type: "user", id: "u1", at: 1, text: "Refactor the parser" },
  { type: "assistant", id: "a1", at: 2, text: "Refactored parser.ts" },
  { type: "tool_call", id: "t1", at: 3, call: { toolCallId: "c1", kind: "edit", status: "completed",
    content: [{ type: "diff", path: "src/parser.ts", oldText: "a", newText: "b" }] } },
];

function seed() {
  const store = useAgentChatStore.getState();
  store.setSnapshot(chatId, claude);
  useAgentChatStore.setState((state) => { state.chats[chatId].items = structuredClone(oldItems); });
}

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); useAgentChatStore.getState().dropChat(chatId);
  vi.mocked(agentChatService.start).mockResolvedValue(codex);
  vi.mocked(agentChatService.prompt).mockResolvedValue(undefined);
  vi.mocked(agentChatService.saveTranscript).mockResolvedValue(undefined);
});

describe("engine handoff flow", () => {
  it("restarts the same chat with the new engine and keeps old items as a read-only prefix", async () => {
    seed();
    const ok = await switchChatEngine({ chatId, target: { id: "codex", label: "Codex", available: true, requirement: "" }, currentEngineLabel: "Claude Code", cwd: "/repo" });
    expect(ok).toBe(true);
    expect(agentChatService.start).toHaveBeenCalledWith(chatId, "codex", "/repo", undefined, []);
    const chat = useAgentChatStore.getState().chats[chatId];
    expect(chat.items.slice(0, 3).map((item) => item.id)).toEqual(["u1", "a1", "t1"]);
    const divider = chat.items[3];
    expect(divider).toMatchObject({ type: "notice", handoff: { from: "Claude Code · Sonnet", to: "Codex", fromEngineId: "claude", toEngineId: "codex" } });
    expect(chat.transcriptStart).toBe(4);
    expect(chat.snapshot?.engineId).toBe("codex");
    expect(chatEngineTrail(chat)).toEqual(["claude", "codex"]);
    expect(chat.pendingHandoff?.text).toContain("Refactor the parser");
    expect(chat.pendingHandoff?.text).toContain("- src/parser.ts");
    // 新会话转写：前缀（含分隔线）落盘为继承段，引擎序列写进 meta。
    expect(agentChatService.saveTranscript).toHaveBeenCalledWith("new-session", [], {
      inherited: expect.arrayContaining([expect.objectContaining({ id: "u1" }), expect.objectContaining({ id: divider.id })]),
      engines: ["claude", "codex"],
    });
    // 切换后没有用户消息时不主动发送。
    expect(agentChatService.prompt).not.toHaveBeenCalled();
  });

  it("prepends the handoff context to the first prompt only, without showing it in the bubble", async () => {
    seed();
    await switchChatEngine({ chatId, target: { id: "codex", label: "Codex", available: true, requirement: "" }, cwd: "/repo" });
    const blocks = [{ type: "text", text: "Continue please" }];
    const first = useAgentChatStore.getState().beginPrompt(chatId, { text: "Continue please", promptBlocks: blocks })!;
    await submitReservedPrompt(chatId, first, blocks);
    const sent = vi.mocked(agentChatService.prompt).mock.calls[0][1] as { type: string; text: string }[];
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toContain("<handoff_context>");
    expect(sent[1]).toEqual(blocks[0]);
    const after = useAgentChatStore.getState().chats[chatId].items;
    const bubble = after[after.length - 1];
    expect(bubble).toMatchObject({ type: "user", text: "Continue please", promptBlocks: blocks });
    expect(useAgentChatStore.getState().chats[chatId].pendingHandoff).toBeNull();

    useAgentChatStore.getState().turnEnded(chatId, "end_turn");
    useAgentChatStore.getState().setSnapshot(chatId, codex);
    const second = useAgentChatStore.getState().beginPrompt(chatId, { text: "Again", promptBlocks: [{ type: "text", text: "Again" }] })!;
    await submitReservedPrompt(chatId, second, [{ type: "text", text: "Again" }]);
    expect(vi.mocked(agentChatService.prompt).mock.calls[1][1]).toEqual([{ type: "text", text: "Again" }]);
  });

  it("keeps the pending context when the first send is rejected", async () => {
    seed();
    await switchChatEngine({ chatId, target: { id: "codex", label: "Codex", available: true, requirement: "" }, cwd: "/repo" });
    vi.mocked(agentChatService.prompt).mockRejectedValueOnce(new Error("busy"));
    const blocks = [{ type: "text", text: "Hi" }];
    const token = useAgentChatStore.getState().beginPrompt(chatId, { text: "Hi", promptBlocks: blocks })!;
    await expect(submitReservedPrompt(chatId, token, blocks)).rejects.toThrow("busy");
    expect(useAgentChatStore.getState().chats[chatId].pendingHandoff).not.toBeNull();
  });

  it("refuses to switch while generating or with pending permissions", async () => {
    seed();
    useAgentChatStore.getState().setSnapshot(chatId, { ...claude, phase: "generating" });
    expect(canSwitchEngine(useAgentChatStore.getState().chats[chatId])).toBe(false);
    expect(await switchChatEngine({ chatId, target: { id: "codex", label: "Codex", available: true, requirement: "" }, cwd: "/repo" })).toBe(false);
    useAgentChatStore.getState().setSnapshot(chatId, claude);
    useAgentChatStore.getState().enqueuePermission(chatId, { requestKey: "k", params: {} });
    expect(canSwitchEngine(useAgentChatStore.getState().chats[chatId])).toBe(false);
    expect(agentChatService.start).not.toHaveBeenCalled();
  });

  it("lists only other available engines; remote chats keep Codex (backend falls back to ACP)", () => {
    const engines = [
      { id: "claude", label: "Claude", available: true, requirement: "" },
      { id: "codex", label: "Codex", available: true, requirement: "" },
      { id: "gemini", label: "Gemini", available: false, requirement: "install" },
      { id: "codex-app-server", label: "Codex App Server", available: true, requirement: "" },
    ];
    expect(handoffTargets(engines, "claude", false).map((engine) => engine.id)).toEqual(["codex", "codex-app-server"]);
    expect(handoffTargets(engines, "claude", true).map((engine) => engine.id)).toEqual(["codex", "codex-app-server"]);
    expect(snapshotModelLabel({ ...codex, configOptions: [{ configId: "m", category: "model", currentValue: "gpt", options: [{ value: "gpt", name: "GPT-5" }] }] })).toBe("GPT-5");
  });
});
