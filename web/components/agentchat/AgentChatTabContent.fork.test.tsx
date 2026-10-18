import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "@/types";
import type { AcpChatSnapshot } from "@/types/agentChat";
import { agentChatService } from "@/services/agentChatService";
import { forkReviewService } from "@/services/forkReviewService";
import type { PreparedChatFork } from "@/types/forkReview";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import AgentChatTabContent from "./AgentChatTabContent";

const { openAgentChat } = vi.hoisted(() => ({ openAgentChat: vi.fn() }));
vi.mock("@/stores", () => ({ usePanesStore: { getState: () => ({ openAgentChat }) } }));
vi.mock("@/stores/agentChatEvents", () => ({ ensureAgentChatListener: vi.fn(), dropAgentChatState: vi.fn() }));
vi.mock("@/services/agentChatService", () => ({ agentChatService: { get: vi.fn(), fork: vi.fn(), stop: vi.fn() } }));
vi.mock("@/services/forkReviewService", () => ({ forkReviewService: { prepare: vi.fn() } }));
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
const tab = { id: parentId, title: "Parent conversation", contentType: "agent-chat", projectPath: "/repo" } as Tab;
const snapshot: AcpChatSnapshot = {
  chatId: parentId, engineId: "codex", acpSessionId: "parent-session", phase: "ready",
  agentCapabilities: { sessionCapabilities: { fork: {} } },
};

function prepared(cwd: string): PreparedChatFork {
  return { cwd, record: {
    id: "fork-review", createdAt: "2026-10-19T00:00:00Z", mode: cwd === "/repo" ? "same-directory" : "worktree",
    sourceCwd: "/repo", targetCwd: cwd, sourceTabId: parentId, sourceSessionId: "parent-session",
    baseline: { repositoryRoot: "/repo", head: "head", tree: "tree", fingerprint: "fingerprint", snapshotRepository: "/snapshots" },
  } };
}

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
  vi.mocked(forkReviewService.prepare).mockImplementation(async ({ cwd }) => prepared(cwd));
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
    expect(forkReviewService.prepare).not.toHaveBeenCalled();
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
    expect(forkReviewService.prepare).not.toHaveBeenCalled();
    expect(agentChatService.fork).not.toHaveBeenCalled();
  });

  it.each(["pending", "error", "session", "directory"])("rechecks %s changes after worktree preparation", async (change) => {
    let finishPreparation!: (result: PreparedChatFork) => void;
    vi.mocked(forkReviewService.prepare).mockImplementation(() => new Promise((resolve) => { finishPreparation = resolve; }));
    await openDialog(true);
    fireEvent.click(screen.getByRole("button", { name: "创建聊天分叉" }));
    await waitFor(() => expect(forkReviewService.prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd: "/repo", mode: "worktree", sourceTabId: parentId, sourceSessionId: "parent-session", childTabId: expect.any(String) })));
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
    await act(async () => finishPreparation(prepared("/repo-worktrees/child")));
    expect(await screen.findByRole("alert")).toHaveTextContent("/repo-worktrees/child");
    expect(agentChatService.fork).not.toHaveBeenCalled();
    expect(agentChatService.stop).not.toHaveBeenCalled();
    expect(openAgentChat).not.toHaveBeenCalled();
    expect(useAgentChatStore.getState().chats[parentId]).toEqual(parent);
  });

  it.each([false, true])("forks a ready source independently with worktree=%s", async (worktree) => {
    vi.mocked(forkReviewService.prepare).mockResolvedValue(prepared(worktree ? "/repo-worktrees/child" : "/repo"));
    const parent = structuredClone(useAgentChatStore.getState().chats[parentId]);
    await openDialog(worktree);
    fireEvent.click(screen.getByRole("button", { name: "创建聊天分叉" }));
    await waitFor(() => expect(openAgentChat).toHaveBeenCalledOnce());
    const [cwd, { tabId, parentTabId, forkReviewId }] = openAgentChat.mock.calls[0];
    expect(parentTabId).toBe(parentId);
    expect(forkReviewId).toBe("fork-review");
    expect(forkReviewService.prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      cwd: "/repo", mode: worktree ? "worktree" : "same-directory", sourceTabId: parentId,
      childTabId: tabId, sourceSessionId: "parent-session", title: "Parent conversation", engineId: "codex",
    }));
    expect(tabId).not.toBe(parentId);
    expect(agentChatService.fork).toHaveBeenCalledExactlyOnceWith(parentId, tabId, cwd);
    expect(useAgentChatStore.getState().chats[tabId].items).toEqual(parent.items);
    expect(useAgentChatStore.getState().chats[tabId].snapshot?.acpSessionId).toBe("child-session");
    expect(useAgentChatStore.getState().chats[tabId].transcriptSessionId).toBe("child-session");
    expect(useAgentChatStore.getState().chats[tabId].transcriptStart).toBe(0);
    expect(useAgentChatStore.getState().chats[parentId]).toEqual(parent);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("copies the latest completed transcript after worktree preparation", async () => {
    let finishPreparation!: (result: PreparedChatFork) => void;
    vi.mocked(forkReviewService.prepare).mockImplementation(() => new Promise((resolve) => { finishPreparation = resolve; }));
    await openDialog(true);
    fireEvent.click(screen.getByRole("button", { name: "创建聊天分叉" }));
    await waitFor(() => expect(forkReviewService.prepare).toHaveBeenCalledOnce());
    act(() => {
      useAgentChatStore.getState().addUserMessage(parentId, "Another completed turn");
      useAgentChatStore.getState().appendStreamText(parentId, "assistant", "Latest answer");
    });
    const parent = structuredClone(useAgentChatStore.getState().chats[parentId]);
    await act(async () => finishPreparation(prepared("/repo-worktrees/child")));
    await waitFor(() => expect(openAgentChat).toHaveBeenCalledOnce());
    const childId = openAgentChat.mock.calls[0][1].tabId;
    expect(useAgentChatStore.getState().chats[childId].items).toEqual(parent.items);
    expect(useAgentChatStore.getState().chats[parentId]).toEqual(parent);
  });

  it("keeps native same-directory forks available when no Git baseline can be saved", async () => {
    vi.mocked(forkReviewService.prepare).mockResolvedValue({ cwd: "/repo", record: null, unavailableReason: "Not a Git repository" });
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: "创建聊天分叉" }));
    await waitFor(() => expect(openAgentChat).toHaveBeenCalledOnce());
    expect(openAgentChat.mock.calls[0][1]).toMatchObject({ parentTabId: parentId });
    expect(openAgentChat.mock.calls[0][1].forkReviewId).toBeUndefined();
  });

  it("does not fork or stop a child when baseline preparation fails", async () => {
    vi.mocked(forkReviewService.prepare).mockRejectedValue(new Error("Cannot save baseline"));
    await openDialog(true);
    fireEvent.click(screen.getByRole("button", { name: "创建聊天分叉" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot save baseline");
    expect(agentChatService.fork).not.toHaveBeenCalled();
    expect(agentChatService.stop).not.toHaveBeenCalled();
    expect(openAgentChat).not.toHaveBeenCalled();
  });

  it("passes the source's preserved prefix through the UI fork and subsequent replay", async () => {
    const store = useAgentChatStore.getState();
    store.preserveTranscriptPrefix(parentId);
    store.addUserMessage(parentId, "Current project question");
    store.appendStreamText(parentId, "assistant", "Current project answer");
    const parent = structuredClone(useAgentChatStore.getState().chats[parentId]);
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: "创建聊天分叉" }));
    await waitFor(() => expect(openAgentChat).toHaveBeenCalledOnce());
    const childId = openAgentChat.mock.calls[0][1].tabId;
    expect(useAgentChatStore.getState().chats[childId].transcriptStart).toBe(2);
    act(() => {
      store.beginHistoryReplay(childId, "child-session");
      store.addUserMessage(childId, "Current project question");
      store.appendStreamText(childId, "assistant", "Current project answer");
      store.finishHistoryReplay(childId, "child-session", true);
    });
    expect(useAgentChatStore.getState().chats[childId].items.slice(0, 2)).toEqual(parent.items.slice(0, 2));
    expect(useAgentChatStore.getState().chats[childId].items).toHaveLength(4);
    expect(useAgentChatStore.getState().chats[parentId]).toEqual(parent);
  });
});
