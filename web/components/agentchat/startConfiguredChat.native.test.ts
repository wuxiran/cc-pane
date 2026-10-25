import "@/i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpChatSnapshot } from "@/types/agentChat";
import { agentChatService } from "@/services/agentChatService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { savePreferredConfigOption, savePreferredModel } from "./enginePrefs";
import { startConfiguredChat } from "./startConfiguredChat";

vi.mock("@/services/agentChatService", () => ({ agentChatService: {
  start: vi.fn(), get: vi.fn(), setMode: vi.fn(), setModel: vi.fn(), setConfigOption: vi.fn(), prompt: vi.fn(),
} }));

const chatId = "native-preferences";
const engineId = "codex-app-server";
function snapshot(model: string, effort: string, efforts: string[]): AcpChatSnapshot {
  return { chatId, engineId, phase: "ready", acpSessionId: "native-thread", codexThreadId: "native-thread", configOptions: [
    { configId: "model", category: "model", currentValue: model, options: [{ value: "model-a" }, { value: "model-b" }] },
    { configId: "reasoning_effort", currentValue: effort, options: efforts.map((value) => ({ value })) },
  ] };
}

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); useAgentChatStore.getState().dropChat(chatId);
  vi.mocked(agentChatService.start).mockResolvedValue(snapshot("model-a", "low", ["low", "medium"]));
  vi.mocked(agentChatService.get).mockResolvedValue(snapshot("model-b", "medium", ["medium", "high"]));
  vi.mocked(agentChatService.setConfigOption).mockResolvedValue(undefined);
  vi.mocked(agentChatService.prompt).mockResolvedValue(undefined);
  savePreferredModel(engineId, "model-b");
});

describe("native model-dependent preference refresh", () => {
  it("applies an effort advertised only by the newly selected model before sending", async () => {
    savePreferredConfigOption(engineId, "reasoning_effort", "high");
    await startConfiguredChat({ chatId, engineId, cwd: "/repo", firstPrompt: "Work" });
    expect(agentChatService.setConfigOption).toHaveBeenNthCalledWith(1, chatId, "model", "model-b");
    expect(agentChatService.get).toHaveBeenCalledWith(chatId);
    expect(agentChatService.setConfigOption).toHaveBeenNthCalledWith(2, chatId, "reasoning_effort", "high");
    expect(vi.mocked(agentChatService.setConfigOption).mock.invocationCallOrder[1])
      .toBeLessThan(vi.mocked(agentChatService.prompt).mock.invocationCallOrder[0]);
    expect(agentChatService.prompt).toHaveBeenCalledWith(chatId, [{ type: "text", text: "Work" }]);
  });

  it("does not send a stale effort valid only for the previous model", async () => {
    savePreferredConfigOption(engineId, "reasoning_effort", "low");
    await startConfiguredChat({ chatId, engineId, cwd: "/repo", firstPrompt: "Work" });
    expect(agentChatService.setConfigOption).toHaveBeenCalledExactlyOnceWith(chatId, "model", "model-b");
    expect(agentChatService.prompt).toHaveBeenCalledOnce();
  });

  it("does not send the first prompt if configuration refresh belongs to another thread", async () => {
    vi.mocked(agentChatService.get).mockResolvedValue({ ...snapshot("model-b", "high", ["high"]), acpSessionId: "other-thread" });
    await expect(startConfiguredChat({ chatId, engineId, cwd: "/repo", firstPrompt: "Work" })).rejects.toThrow("configuration changed");
    expect(agentChatService.prompt).not.toHaveBeenCalled();
  });
});
