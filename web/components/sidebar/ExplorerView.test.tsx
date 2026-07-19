import { act, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ExplorerView from "./ExplorerView";
import { useExplorerSectionsStore, useWorkspacesStore } from "@/stores";
import { invokeOrApi } from "@/services/apiClient";
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
    vi.mocked(invokeOrApi).mockImplementation(async () => null);
    useExplorerSectionsStore.setState({ activeSection: "workspaces" });
    useWorkspacesStore.setState({
      workspaces: [],
      expandedWorkspaceId: null,
      expandedProjectId: null,
    });
  });

  it("renders the EXPLORER header and three segmented tabs, workspaces active by default", () => {
    render(<TooltipProvider><ExplorerView onOpenTerminal={vi.fn()} /></TooltipProvider>);
    expect(screen.getByText("EXPLORER")).toBeVisible();
    expect(screen.getByRole("tab", { name: "explorer.tabWorkspaces" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "explorer.tabFiles" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(screen.getByRole("tab", { name: "explorer.tabGit" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(screen.getByText("workspace-tree-stub")).toBeVisible();
  });

  it("forwards onOpenTerminal from the workspace tree", () => {
    const onOpenTerminal = vi.fn();
    render(<TooltipProvider><ExplorerView onOpenTerminal={onOpenTerminal} /></TooltipProvider>);
    fireEvent.click(screen.getByText("workspace-tree-stub"));
    expect(onOpenTerminal).toHaveBeenCalledWith({ path: "/tmp/from-tree" });
  });

  it("switches to the files tab, persists the active section, and keeps the tree alive but hidden", () => {
    render(<TooltipProvider><ExplorerView onOpenTerminal={vi.fn()} /></TooltipProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "explorer.tabFiles" }));

    expect(useExplorerSectionsStore.getState().activeSection).toBe("files");
    // keep-alive：树仍挂载（Dialogs 不丢），仅 display:none 隐藏
    expect(screen.getByText("workspace-tree-stub")).not.toBeVisible();
    expect(screen.getByText("explorer.selectWorkspaceHint")).toBeVisible();
  });

  it("lists all projects in the files tab and lazily mounts only the selected project's tree", () => {
    selectWorkspaceWithProject("proj-1");
    useExplorerSectionsStore.setState({ activeSection: "files" });
    render(<TooltipProvider><ExplorerView onOpenTerminal={vi.fn()} /></TooltipProvider>);

    // 两个项目根都列出
    expect(screen.getByText("demo")).toBeVisible();
    expect(screen.getByText("other")).toBeVisible();
    // 仅选中项目挂载 FileTree（懒加载）
    const trees = screen.getAllByTestId("file-tree");
    expect(trees).toHaveLength(1);
    expect(trees[0]).toHaveTextContent("D:/repos/demo");
  });

  it("mounts a collapsed project's tree when its root node is expanded", () => {
    selectWorkspaceWithProject("proj-1");
    useExplorerSectionsStore.setState({ activeSection: "files" });
    render(<TooltipProvider><ExplorerView onOpenTerminal={vi.fn()} /></TooltipProvider>);

    fireEvent.click(screen.getByText("other"));

    const trees = screen.getAllByTestId("file-tree");
    expect(trees).toHaveLength(2);
  });

  it("follows expandedProjectId changes in the files tab", () => {
    selectWorkspaceWithProject("proj-1");
    useExplorerSectionsStore.setState({ activeSection: "files" });
    render(<TooltipProvider><ExplorerView onOpenTerminal={vi.fn()} /></TooltipProvider>);
    expect(screen.getByTestId("file-tree")).toHaveTextContent("D:/repos/demo");

    act(() => {
      useWorkspacesStore.setState({ expandedProjectId: "proj-2" });
    });

    const trees = screen.getAllByTestId("file-tree");
    expect(trees).toHaveLength(1);
    expect(trees[0]).toHaveTextContent("D:/repos/other");
  });

  it("lists all projects as groups in the git tab with not-a-git-repo hints", async () => {
    selectWorkspaceWithProject("proj-1");
    useExplorerSectionsStore.setState({ activeSection: "git" });
    render(<TooltipProvider><ExplorerView onOpenTerminal={vi.fn()} /></TooltipProvider>);

    expect(screen.getByText("demo")).toBeVisible();
    expect(screen.getByText("other")).toBeVisible();
    // 组头（两个非 git 项目）+ 选中项目展开的组体各一条
    const hints = await screen.findAllByText("explorer.notGitRepo");
    expect(hints.length).toBeGreaterThanOrEqual(2);
  });

  it("shows an unavailable hint when the git query fails (silent tolerance)", async () => {
    vi.mocked(invokeOrApi).mockImplementation(async () => {
      throw new Error("ssh timeout");
    });
    selectWorkspaceWithProject("proj-1");
    useExplorerSectionsStore.setState({ activeSection: "git" });
    render(<TooltipProvider><ExplorerView onOpenTerminal={vi.fn()} /></TooltipProvider>);

    const hints = await screen.findAllByText("explorer.gitUnavailable");
    expect(hints.length).toBeGreaterThanOrEqual(2);
  });
});
