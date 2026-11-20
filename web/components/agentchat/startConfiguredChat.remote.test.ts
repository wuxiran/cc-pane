import "@/i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentChatService } from "@/services/agentChatService";
import { worktreeService } from "@/services/worktreeService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { startConfiguredChat } from "./startConfiguredChat";

vi.mock("@/services/agentChatService", () => ({ agentChatService: {
  start: vi.fn(), setMode: vi.fn(), setModel: vi.fn(), setConfigOption: vi.fn(), prompt: vi.fn(),
} }));
vi.mock("@/services/worktreeService", () => ({ worktreeService: { add: vi.fn() } }));
const chatId = "remote-launch-test";
const remote = { machineId: "m1", os: "linux" };
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); useAgentChatStore.getState().dropChat(chatId);
  vi.mocked(agentChatService.start).mockResolvedValue({ chatId, engineId: "claude", phase: "ready" });
});

describe("remote agent chat launch", () => {
  it("starts on the machine with the remote cwd and never adopts it as a local cwd", async () => {
    const onCwdAdopted = vi.fn();
    await startConfiguredChat({ chatId, engineId: "claude", cwd: "~/work", remote, onCwdAdopted });
    expect(agentChatService.start).toHaveBeenCalledExactlyOnceWith(chatId, "claude", "~/work", undefined, [], remote);
    expect(onCwdAdopted).not.toHaveBeenCalled();
    expect(useAgentChatStore.getState().chats[chatId]?.cwdOverride ?? null).toBeNull();
  });

  it("refuses a worktree for a remote launch without touching git", async () => {
    await expect(startConfiguredChat({
      chatId, engineId: "claude", cwd: "~/work", remote,
      worktree: { enabled: true, branch: "cc/task" },
    })).rejects.toThrow();
    expect(worktreeService.add).not.toHaveBeenCalled();
    expect(agentChatService.start).not.toHaveBeenCalled();
  });
});
