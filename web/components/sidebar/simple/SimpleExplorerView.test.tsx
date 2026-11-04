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
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const firstPrompts = new Map<string, string>();
vi.mock("@/hooks/useFirstPromptIndex", () => ({ useFirstPromptIndex: () => firstPrompts }));

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
    firstPrompts.clear();
    listHistory.mockResolvedValue([terminalRecord]);
    listChats.mockResolvedValue([chatEntry]);
    deleteHistory.mockResolvedValue(undefined);
    deleteChat.mockResolvedValue(undefined);
    useWorkspacesStore.setState({ workspaces, expandedWorkspaceId: null, expandedProjectId: null });
    useSshMachinesStore.setState({ machines: [] } as never);
    useExplorerSectionsStore.setState({ explorerMode: "simple", preferredContextWorkspaceName: null, pinnedSessionKeys: [], collapsedSimpleProjects: [] });
    useDialogStore.setState({ launcherOpen: false, launcherContext: null, newWorkspaceRequested: false });
  });

  it("lists projects of user workspaces only, sessions nested under their project, plus recent", async () => {
    await renderView();
    const projectRows = screen.getAllByTestId("simple-project-row");
    expect(projectRows.map((row) => row.getAttribute("data-project-path"))).toEqual(["/repos/demo", "/repos/empty"]);
    // 系统工作空间不露出；单工作空间时不显示工作空间小标题
    expect(screen.queryByText("default")).not.toBeInTheDocument();
    expect(screen.queryByTestId("simple-workspace-caption")).not.toBeInTheDocument();
    expect(screen.queryByText("simple.other")).not.toBeInTheDocument();
    // 项目区两条（对话更新时间更晚排前）+ 最近区两条
    const rows = screen.getAllByTestId("simple-session-row");
    expect(rows.map((row) => row.getAttribute("data-session-key"))).toEqual(["chat:chat-1", "launch:1", "chat:chat-1", "launch:1"]);
    expect(within(rows[1]).getByText("fix the build")).toBeInTheDocument();
  });

  it("titles terminal rows with the indexed first prompt when available", async () => {
    firstPrompts.set("sess-1", "optimize the sidebar");
    await renderView();
    const terminalRow = screen.getAllByTestId("simple-session-row")[1];
    expect(within(terminalRow).getByText("optimize the sidebar")).toBeInTheDocument();
    expect(within(terminalRow).queryByText("fix the build")).not.toBeInTheDocument();
  });

  it("shows workspace captions when there is more than one user workspace", async () => {
    useWorkspacesStore.setState({ workspaces: [...workspaces, ws({ name: "beta", projects: [{ id: "c", path: "/beta" }] })] });
    await renderView();
    expect(screen.getAllByTestId("simple-workspace-caption").map((el) => el.textContent)).toEqual(["cc-pane", "beta"]);
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

  it("collapses a project and persists the choice in the store", async () => {
    await renderView();
    fireEvent.click(screen.getAllByTestId("simple-project-row")[0]);
    expect(useExplorerSectionsStore.getState().collapsedSimpleProjects).toEqual(["/repos/demo"]);
    // 折叠后项目下不再列会话，只剩最近区的两条
    expect(screen.getAllByTestId("simple-session-row")).toHaveLength(2);
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
