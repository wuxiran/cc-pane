import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ExplorerView from "./ExplorerView";
import { useDialogStore, useExplorerSectionsStore, useWorkspacesStore } from "@/stores";
import { gitService } from "@/services/gitService";
import type { OpenTerminalOptions, Workspace } from "@/types";

// --- i18n: t 直接回 key，便于断言 ---
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // 依赖链里有模块引入 "@/i18n"（其初始化调用 initReactI18next），mock 需一并提供
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

// --- WorkspaceTree stub ---
interface WorkspaceTreeStubProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}
vi.mock("@/components/sidebar/WorkspaceTree", () => ({
  default: ({ onOpenTerminal }: WorkspaceTreeStubProps) => (
    <button
      type="button"
      onClick={() => onOpenTerminal({ path: "/tmp/from-tree" } as OpenTerminalOptions)}
    >
      workspace-tree-stub
    </button>
  ),
}));

// --- SessionsView stub：keep-alive 下始终挂载，桩掉其 history/PTY 依赖 ---
vi.mock("@/components/sidebar/SessionsView", () => ({
  default: ({ onOpenTerminal }: WorkspaceTreeStubProps) => (
    <button
      type="button"
      onClick={() => onOpenTerminal({ path: "/tmp/from-sessions" } as OpenTerminalOptions)}
    >
      sessions-view-stub
    </button>
  ),
}));

// --- FileTree stub ---
vi.mock("@/components/filetree", () => ({
  FileTree: ({ rootPath }: { rootPath: string }) => (
    <div data-testid="file-tree">{rootPath}</div>
  ),
}));

// --- Git 数据源 stub：默认分支查不到 → 非 Git 项目 ---
vi.mock("@/services/apiClient", () => ({
  invokeOrApi: vi.fn(async () => null),
  apiGet: vi.fn(async () => null),
}));
vi.mock("@/services/gitService", () => ({
  gitService: {
    getRepoInfo: vi.fn(async () => ({
      state: "notARepo",
      repoRoot: null,
      branch: null,
      hasChanges: null,
      message: null,
    })),
    getFileStatuses: vi.fn(async () => ({})),
  },
}));
vi.mock("@/services/filesystemService", () => ({
  filesystemService: { getGitFileStatuses: vi.fn(async () => ({})) },
}));

function makeWorkspace(): Workspace {
  return {
    id: "ws-1",
    name: "alpha",
    path: null,
    projects: [
      { id: "proj-1", path: "D:/repos/demo" },
      { id: "proj-2", path: "D:/repos/other" },
    ],
  } as unknown as Workspace;
}

function selectWorkspaceWithProject(projectId: string | null = "proj-1") {
  useWorkspacesStore.setState({
    workspaces: [makeWorkspace()],
    expandedWorkspaceId: "ws-1",
    expandedProjectId: projectId,
  });
}

describe("ExplorerView", () => {
  beforeEach(() => {
    vi.mocked(gitService.getRepoInfo).mockResolvedValue({
      state: "notARepo",
      repoRoot: null,
      branch: null,
      hasChanges: null,
      message: null,
    });
    useExplorerSectionsStore.setState({ activeSection: "workspaces" });
    useDialogStore.setState({ launcherOpen: false, launcherContext: null });
    useWorkspacesStore.setState({
      workspaces: [],
      expandedWorkspaceId: null,
      expandedProjectId: null,
    });
  });

  it("renders the EXPLORER header and two segmented tabs, workspaces active by default", () => {
    render(<TooltipProvider><ExplorerView onOpenTerminal={vi.fn()} /></TooltipProvider>);
    expect(screen.getByText("EXPLORER")).toBeVisible();
    expect(screen.queryByRole("button", { name: "openLauncher" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /launchTerminal/ })).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "explorer.tabWorkspaces" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "recentLaunches" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    // 文件 / Git 已迁往 RightDock，左侧不再有入口
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByText("workspace-tree-stub")).toBeVisible();
  });

  it("switches to the recent-launches tab and keeps both views mounted (keep-alive)", () => {
    render(<TooltipProvider><ExplorerView onOpenTerminal={vi.fn()} /></TooltipProvider>);
    // 未选中时已挂载但隐藏
    expect(screen.getByText("sessions-view-stub")).not.toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "recentLaunches" }));

    expect(useExplorerSectionsStore.getState().activeSection).toBe("sessions");
    expect(screen.getByText("sessions-view-stub")).toBeVisible();
    // 工作空间树同样 keep-alive，仅隐藏
    expect(screen.getByText("workspace-tree-stub")).not.toBeVisible();
  });

  it("forwards onOpenTerminal from the recent-launches view", () => {
    const onOpenTerminal = vi.fn();
    useExplorerSectionsStore.setState({ activeSection: "sessions" });
    render(<TooltipProvider><ExplorerView onOpenTerminal={onOpenTerminal} /></TooltipProvider>);
    fireEvent.click(screen.getByText("sessions-view-stub"));
    expect(onOpenTerminal).toHaveBeenCalledWith({ path: "/tmp/from-sessions" });
  });

  it("forwards onOpenTerminal from the workspace tree", () => {
    const onOpenTerminal = vi.fn();
    render(<TooltipProvider><ExplorerView onOpenTerminal={onOpenTerminal} /></TooltipProvider>);
    fireEvent.click(screen.getByText("workspace-tree-stub"));
    expect(onOpenTerminal).toHaveBeenCalledWith({ path: "/tmp/from-tree" });
  });

  it("opens the global launcher from the persistent bottom button with the workspace context", () => {
    selectWorkspaceWithProject(null);
    render(<TooltipProvider><ExplorerView onOpenTerminal={vi.fn()} /></TooltipProvider>);

    fireEvent.click(screen.getByRole("button", { name: /launchTerminal/ }));

    expect(useDialogStore.getState().launcherOpen).toBe(true);
    expect(useDialogStore.getState().launcherContext).toEqual({ workspaceName: "alpha" });
  });

  it("includes the expanded project path in the launcher context", () => {
    selectWorkspaceWithProject("proj-2");
    render(<TooltipProvider><ExplorerView onOpenTerminal={vi.fn()} /></TooltipProvider>);

    fireEvent.click(screen.getByRole("button", { name: /launchTerminal/ }));

    expect(useDialogStore.getState().launcherContext).toEqual({
      workspaceName: "alpha",
      projectPath: "D:/repos/other",
    });
  });

  it("keeps the bottom launch button mounted while the sessions tab is active", () => {
    useExplorerSectionsStore.setState({ activeSection: "sessions" });
    render(<TooltipProvider><ExplorerView onOpenTerminal={vi.fn()} /></TooltipProvider>);
    expect(screen.getByRole("button", { name: /launchTerminal/ })).toBeVisible();
  });
});
