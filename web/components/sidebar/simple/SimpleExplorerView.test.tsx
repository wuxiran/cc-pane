import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDialogStore, useExplorerSectionsStore, useSshMachinesStore, useWorkspacesStore } from "@/stores";
import type { Workspace } from "@/types";
import SimpleExplorerView from "./SimpleExplorerView";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

const listHistory = vi.fn();
const deleteHistory = vi.fn();
vi.mock("@/services/historyService", () => ({
  historyService: { list: (...args: unknown[]) => listHistory(...args), delete: (...args: unknown[]) => deleteHistory(...args) },
}));
const listChats = vi.fn();
const deleteChat = vi.fn();
vi.mock("@/services/agentChatService", () => ({
  agentChatService: { listHistory: () => listChats(), deleteHistory: (...args: unknown[]) => deleteChat(...args) },
}));
const resumeAgentChat = vi.fn();
const openNewAgentChat = vi.fn();
vi.mock("../agentChatResume", () => ({
  resumeAgentChat: (...args: unknown[]) => resumeAgentChat(...args),
  openNewAgentChat: (...args: unknown[]) => openNewAgentChat(...args),
}));
vi.mock("@/components/ui/toast", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function ws(partial: Partial<Workspace> & { name: string }): Workspace {
  return { id: partial.name, createdAt: "", projects: [], ...partial } as Workspace;
}

const workspaces = [
  ws({ name: "default", isDefault: true, projects: [{ id: "d", path: "/base/default" }] }),
  ws({ name: "agent-chat", isAgentChat: true }),
  ws({ name: "cc-pane", path: "/repos", projects: [{ id: "a", path: "/repos/demo" }, { id: "b", path: "/repos/empty" }] }),
];

const terminalRecord = {
  id: 1, projectId: "a", projectName: "demo", projectPath: "/repos/demo",
  launchedAt: "2026-11-03T10:00:00Z", resumeSessionId: "sess-1", lastPrompt: "fix the build", cliTool: "claude",
};
const chatEntry = { acpSessionId: "chat-1", engineId: "codex", cwd: "/repos/demo/pkg", title: "plan the release", createdAt: 1, updatedAt: Date.parse("2026-11-03T11:00:00Z") };

async function renderView(onOpenTerminal = vi.fn()) {
  render(<TooltipProvider><SimpleExplorerView onOpenTerminal={onOpenTerminal} /></TooltipProvider>);
  await waitFor(() => expect(screen.getAllByTestId("simple-session-row").length).toBeGreaterThan(0));
  return onOpenTerminal;
}

describe("SimpleExplorerView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listHistory.mockResolvedValue([terminalRecord]);
    listChats.mockResolvedValue([chatEntry]);
    deleteHistory.mockResolvedValue(undefined);
    deleteChat.mockResolvedValue(undefined);
    useWorkspacesStore.setState({ workspaces, expandedWorkspaceId: null, expandedProjectId: null });
    useSshMachinesStore.setState({ machines: [] } as never);
    useExplorerSectionsStore.setState({ explorerMode: "simple", preferredContextWorkspaceName: null, pinnedSessionKeys: [], collapsedSimpleProjects: [] });
    useDialogStore.setState({ launcherOpen: false, launcherContext: null, newWorkspaceRequested: false });
  });

  it("lists one row per user workspace with its sessions underneath, plus recent", async () => {
    await renderView();
    const rows = screen.getAllByTestId("simple-workspace-row");
    expect(rows.map((row) => row.getAttribute("data-workspace-name"))).toEqual(["cc-pane"]);
    // 系统工作空间不露出；没有落在工作空间外的会话时不出现「其他」
    expect(screen.queryByText("default")).not.toBeInTheDocument();
    expect(screen.queryByText("simple.other")).not.toBeInTheDocument();
    // 工作空间下两条（两个项目文件夹的会话并成一列，对话更新时间更晚排前）+ 最近区两条
    const sessions = screen.getAllByTestId("simple-session-row");
    expect(sessions.map((row) => row.getAttribute("data-session-key"))).toEqual(["chat:chat-1", "launch:1", "chat:chat-1", "launch:1"]);
    expect(within(sessions[1]).getByText("fix the build")).toBeInTheDocument();
  });

  it("lists every user workspace in order, and sessions outside any workspace under Other", async () => {
    useWorkspacesStore.setState({ workspaces: [...workspaces, ws({ name: "beta", alias: "Beta", projects: [{ id: "c", path: "/beta" }] })] });
    listChats.mockResolvedValue([chatEntry, { ...chatEntry, acpSessionId: "chat-stray", cwd: "/elsewhere" }]);
    await renderView();
    const rows = screen.getAllByTestId("simple-workspace-row");
    expect(rows.map((row) => row.textContent)).toEqual(["cc-pane", "Beta", "simple.other"]);
  });

  it("shows only the first few sessions until Show more is clicked", async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      ...chatEntry, acpSessionId: `chat-${index}`, title: `chat ${index}`, updatedAt: 1_000 + index,
    }));
    listChats.mockResolvedValue(many);
    listHistory.mockResolvedValue([]);
    await renderView();
    const projects = screen.getByRole("region", { name: "simple.projects" });
    expect(within(projects).getAllByTestId("simple-session-row")).toHaveLength(5);
    fireEvent.click(within(projects).getByText("simple.showMore"));
    expect(within(projects).getAllByTestId("simple-session-row")).toHaveLength(8);
    fireEvent.click(within(projects).getByText("simple.showLess"));
    expect(within(projects).getAllByTestId("simple-session-row")).toHaveLength(5);
  });

  it("offers no Show more when everything already fits", async () => {
    await renderView();
    expect(screen.queryByTestId("simple-workspace-show-more")).not.toBeInTheDocument();
  });

  it("opens a terminal session via onOpenTerminal and a chat via resumeAgentChat", async () => {
    const onOpenTerminal = await renderView();
    const [chatRow, terminalRow] = screen.getAllByTestId("simple-session-row");
    fireEvent.click(terminalRow);
    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({ path: "/repos/demo", resumeId: "sess-1" }));
    fireEvent.click(chatRow);
    expect(resumeAgentChat).toHaveBeenCalledWith(chatEntry);
  });

  it("uses the first user workspace as launch context when nothing is selected", async () => {
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: /launchTerminal/ }));
    expect(useDialogStore.getState().launcherContext).toEqual({ workspaceName: "cc-pane" });
    fireEvent.click(screen.getByRole("button", { name: "simple.newChat" }));
    expect(openNewAgentChat).toHaveBeenCalledWith("/repos");
  });

  it("honours the preferred context workspace and the selected project", async () => {
    useWorkspacesStore.setState({
      workspaces: [...workspaces, ws({ name: "beta", projects: [{ id: "c", path: "/beta" }] })],
      expandedWorkspaceId: "cc-pane",
      expandedProjectId: "a",
    });
    useExplorerSectionsStore.setState({ preferredContextWorkspaceName: "beta" });
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: /launchTerminal/ }));
    expect(useDialogStore.getState().launcherContext).toEqual({ workspaceName: "cc-pane", projectPath: "/repos/demo" });
    act(() => useWorkspacesStore.setState({ expandedWorkspaceId: null, expandedProjectId: null }));
    fireEvent.click(screen.getByRole("button", { name: /launchTerminal/ }));
    expect(useDialogStore.getState().launcherContext).toEqual({ workspaceName: "beta" });
  });

  it("collapses a workspace and persists the choice in the store", async () => {
    await renderView();
    fireEvent.click(within(screen.getByTestId("simple-workspace-row")).getByRole("button", { name: "cc-pane" }));
    expect(useExplorerSectionsStore.getState().collapsedSimpleProjects).toEqual(["ws:cc-pane"]);
    // 折叠后工作空间下不再列会话，只剩最近区的两条
    expect(screen.getAllByTestId("simple-session-row")).toHaveLength(2);
  });

  it("starts a chat in the workspace from the row's quick action", async () => {
    await renderView();
    fireEvent.click(within(screen.getByTestId("simple-workspace-row")).getByRole("button", { name: "simple.newChatHere" }));
    expect(openNewAgentChat).toHaveBeenCalledWith("/repos");
  });

  it("shows the pinned section for pinned keys", async () => {
    await renderView();
    act(() => useExplorerSectionsStore.getState().togglePinnedSession("launch:1"));
    const pinned = screen.getByRole("region", { name: "simple.pinned" });
    expect(within(pinned).getAllByTestId("simple-session-row")).toHaveLength(1);
  });

  it("shows the empty state when there are no user workspaces", () => {
    useWorkspacesStore.setState({ workspaces: workspaces.slice(0, 2) });
    render(<TooltipProvider><SimpleExplorerView onOpenTerminal={vi.fn()} /></TooltipProvider>);
    expect(screen.getByText("simple.emptyTitle")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "newWorkspace" }));
    expect(useDialogStore.getState().newWorkspaceRequested).toBe(true);
  });
});
