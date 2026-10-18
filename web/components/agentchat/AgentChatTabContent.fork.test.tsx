import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "@/types";
import type { AcpChatSnapshot } from "@/types/agentChat";
import { agentChatService } from "@/services/agentChatService";
import { forkWorkingDirectory } from "@/services/chatForkLaunch";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import AgentChatTabContent from "./AgentChatTabContent";

const { openAgentChat } = vi.hoisted(() => ({ openAgentChat: vi.fn() }));
vi.mock("@/stores", () => ({ usePanesStore: { getState: () => ({ openAgentChat }) } }));
vi.mock("@/stores/agentChatEvents", () => ({ ensureAgentChatListener: vi.fn(), dropAgentChatState: vi.fn() }));
vi.mock("@/services/agentChatService", () => ({ agentChatService: { get: vi.fn(), fork: vi.fn(), stop: vi.fn() } }));
vi.mock("@/services/chatForkLaunch", () => ({ forkWorkingDirectory: vi.fn() }));
vi.mock("./ChatSessionHeader", () => ({ default: ({ onFork, canFork }: { onFork: () => void; canFork: boolean }) =>
  <button disabled={!canFork} onClick={onFork}>Open fork</button> }));
vi.mock("./ChatComposer", () => ({ default: () => null }));
vi.mock("./EnginePicker", () => ({ default: () => null }));
vi.mock("./ChatWelcome", () => ({ default: () => null }));
vi.mock("./ChatTurnView", () => ({ default: () => null }));
vi.mock("./ChatTimelineNavigation", () => ({ default: () => null }));
vi.mock("./ChatPermissionQueue", () => ({ default: () => null }));
vi.mock("./ChatChangesPanel", () => ({ default: () => null, collectNetChanges: () => [] }));

const parentId = "fork-parent";
const tab = { id: parentId, contentType: "agent-chat", projectPath: "/repo" } as Tab;
const snapshot: AcpChatSnapshot = {
  chatId: parentId, engineId: "codex", acpSessionId: "parent-session", phase: "ready",
  agentCapabilities: { sessionCapabilities: { fork: {} } },
};

async function openDialog(worktree = false) {
  render(<AgentChatTabContent tab={tab} />);
  fireEvent.click(screen.getByRole("button", { name: "Open fork" }));
  await screen.findByRole("dialog");
  if (worktree) fireEvent.click(screen.getByRole("radio", { name: "创建独立 Git 工作树后分叉" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  useAgentChatStore.setState({ chats: {} });
  useAgentChatStore.getState().setSnapshot(parentId, snapshot);
  useAgentChatStore.getState().addUserMessage(parentId, "Keep this conversation");
  useAgentChatStore.getState().appendStreamText(parentId, "assistant", "Original response");
  vi.mocked(forkWorkingDirectory).mockImplementation(async (cwd) => cwd);
  vi.mocked(agentChatService.fork).mockImplementation(async (_source, chatId) => ({
    ...snapshot, chatId, acpSessionId: "child-session",
  }));
  vi.mocked(agentChatService.stop).mockResolvedValue(undefined);
  openAgentChat.mockImplementation((_cwd: string, options: { tabId: string }) => options.tabId);
});

describe("fork dialog source revalidation", () => {
  it.each(["pending", "error"])("rejects %s setup after the dialog opened without creating a worktree", async (state) => {
    await openDialog(true);
    act(() => {
      const token = useAgentChatStore.getState().beginSetup(parentId)!;
      if (state === "error") useAgentChatStore.getState().finishSetup(parentId, token, "Configuration rejected");
    });
    const parent = structuredClone(useAgentChatStore.getState().chats[parentId]);
    fireEvent.click(screen.getByRole("button", { name: "创建聊天分叉" }));
    await screen.findByRole("alert");
    expect(forkWorkingDirectory).not.toHaveBeenCalled();
    expect(agentChatService.fork).not.toHaveBeenCalled();
    expect(agentChatService.stop).not.toHaveBeenCalled();
    expect(openAgentChat).not.toHaveBeenCalled();
    expect(useAgentChatStore.getState().chats[parentId]).toEqual(parent);
  });

  it("rejects a replacement session even when it is ready before confirmation", async () => {
    await openDialog(true);
    act(() => useAgentChatStore.getState().setSnapshot(parentId, { ...snapshot, acpSessionId: "replacement" }));
    fireEvent.click(screen.getByRole("button", { name: "创建聊天分叉" }));
    await screen.findByRole("alert");
    expect(forkWorkingDirectory).not.toHaveBeenCalled();
    expect(agentChatService.fork).not.toHaveBeenCalled();
  });

  it.each(["pending", "error", "session", "directory"])("rechecks %s changes after worktree preparation", async (change) => {
    let finishDirectory!: (cwd: string) => void;
    vi.mocked(forkWorkingDirectory).mockImplementation(() => new Promise((resolve) => { finishDirectory = resolve; }));
    await openDialog(true);
    fireEvent.click(screen.getByRole("button", { name: "创建聊天分叉" }));
    expect(forkWorkingDirectory).toHaveBeenCalledExactlyOnceWith("/repo", "worktree");
    act(() => {
      const store = useAgentChatStore.getState();
      if (change === "session") store.setSnapshot(parentId, { ...snapshot, acpSessionId: "replacement" });
      else if (change === "directory") store.setCwdOverride(parentId, "/different-project");
      else {
        const token = store.beginSetup(parentId)!;
        if (change === "error") store.finishSetup(parentId, token, "Configuration rejected");
      }
    });
    const parent = structuredClone(useAgentChatStore.getState().chats[parentId]);
    await act(async () => finishDirectory("/repo-worktrees/child"));
    expect(await screen.findByRole("alert")).toHaveTextContent("/repo-worktrees/child");
    expect(agentChatService.fork).not.toHaveBeenCalled();
    expect(agentChatService.stop).not.toHaveBeenCalled();
    expect(openAgentChat).not.toHaveBeenCalled();
    expect(useAgentChatStore.getState().chats[parentId]).toEqual(parent);
  });

  it.each([false, true])("forks a ready source independently with worktree=%s", async (worktree) => {
    vi.mocked(forkWorkingDirectory).mockResolvedValue(worktree ? "/repo-worktrees/child" : "/repo");
    const parent = structuredClone(useAgentChatStore.getState().chats[parentId]);
    await openDialog(worktree);
    fireEvent.click(screen.getByRole("button", { name: "创建聊天分叉" }));
    await waitFor(() => expect(openAgentChat).toHaveBeenCalledOnce());
    const [cwd, { tabId }] = openAgentChat.mock.calls[0];
    expect(tabId).not.toBe(parentId);
    expect(agentChatService.fork).toHaveBeenCalledExactlyOnceWith(parentId, tabId, cwd);
    expect(useAgentChatStore.getState().chats[tabId].items).toEqual(parent.items);
    expect(useAgentChatStore.getState().chats[tabId].snapshot?.acpSessionId).toBe("child-session");
    expect(useAgentChatStore.getState().chats[parentId]).toEqual(parent);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("copies the latest completed transcript after worktree preparation", async () => {
    let finishDirectory!: (cwd: string) => void;
    vi.mocked(forkWorkingDirectory).mockImplementation(() => new Promise((resolve) => { finishDirectory = resolve; }));
    await openDialog(true);
    fireEvent.click(screen.getByRole("button", { name: "创建聊天分叉" }));
    act(() => {
      useAgentChatStore.getState().addUserMessage(parentId, "Another completed turn");
      useAgentChatStore.getState().appendStreamText(parentId, "assistant", "Latest answer");
    });
    const parent = structuredClone(useAgentChatStore.getState().chats[parentId]);
    await act(async () => finishDirectory("/repo-worktrees/child"));
    await waitFor(() => expect(openAgentChat).toHaveBeenCalledOnce());
    const childId = openAgentChat.mock.calls[0][1].tabId;
    expect(useAgentChatStore.getState().chats[childId].items).toEqual(parent.items);
    expect(useAgentChatStore.getState().chats[parentId]).toEqual(parent);
  });
});
