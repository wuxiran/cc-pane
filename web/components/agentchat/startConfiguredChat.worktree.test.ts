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
const chatId = "worktree-launch-test";
const options = { chatId, engineId: "claude", cwd: "/repo", worktree: {
  enabled: true, branch: "cc/task", baseRef: "refs/heads/main",
} };
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); useAgentChatStore.getState().dropChat(chatId);
  vi.mocked(agentChatService.start).mockResolvedValue({ chatId, engineId: "claude", phase: "ready" });
  vi.mocked(worktreeService.add).mockResolvedValue("/repo-worktrees/cc-task");
});

describe("Agent worktree launch", () => {
  it("sends the first prompt only after the engine starts in the prepared worktree", async () => {
    await startConfiguredChat({ ...options, firstPrompt: "Implement the change" });
    expect(agentChatService.start).toHaveBeenCalledWith(chatId, "claude", "/repo-worktrees/cc-task", undefined, []);
    expect(agentChatService.prompt).toHaveBeenCalledExactlyOnceWith(chatId, [{ type: "text", text: "Implement the change" }]);
    expect(vi.mocked(agentChatService.start).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(agentChatService.prompt).mock.invocationCallOrder[0]);
  });
  it("holds the setup lock across worktree creation and starts exactly once", async () => {
    let finish!: (cwd: string) => void;
    vi.mocked(worktreeService.add).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const first = startConfiguredChat(options);
    await expect(startConfiguredChat(options)).resolves.toBeNull();
    expect(worktreeService.add).toHaveBeenCalledTimes(1);
    expect(agentChatService.start).not.toHaveBeenCalled();
    finish("/repo-worktrees/cc-task");
    await first;
    expect(agentChatService.start).toHaveBeenCalledExactlyOnceWith(chatId, "claude", "/repo-worktrees/cc-task", undefined, []);
  });
  it("retains a created worktree for retry when engine spawn fails", async () => {
    vi.mocked(agentChatService.start).mockRejectedValueOnce(new Error("engine unavailable"));
    await expect(startConfiguredChat(options)).rejects.toThrow("engine unavailable");
    const cwd = useAgentChatStore.getState().chats[chatId]?.cwdOverride;
    expect(cwd).toBe("/repo-worktrees/cc-task");
    await startConfiguredChat({ chatId, engineId: "claude", cwd: cwd! });
    expect(worktreeService.add).toHaveBeenCalledTimes(1);
    expect(agentChatService.start).toHaveBeenLastCalledWith(chatId, "claude", cwd, undefined, []);
  });
  it("keeps configuration available after preparation fails and never launches in the source", async () => {
    vi.mocked(worktreeService.add).mockRejectedValueOnce(new Error("invalid base"));
    await expect(startConfiguredChat(options)).rejects.toThrow("invalid base");
    expect(agentChatService.start).not.toHaveBeenCalled();
    expect(useAgentChatStore.getState().chats[chatId]?.snapshot).toBeNull();
    await startConfiguredChat(options);
    expect(agentChatService.start).toHaveBeenCalledWith(chatId, "claude", "/repo-worktrees/cc-task", undefined, []);
  });
  it("rejects moving a resumed session into a new worktree", async () => {
    await expect(startConfiguredChat({ ...options, resumeAcpSessionId: "session" })).rejects.toThrow();
    expect(worktreeService.add).not.toHaveBeenCalled();
    expect(agentChatService.start).not.toHaveBeenCalled();
  });
});
