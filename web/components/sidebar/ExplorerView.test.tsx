import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ExplorerView from "./ExplorerView";
import { COMMAND_PALETTE_TOGGLE_EVENT } from "@/lib/commands/paletteEvents";
import { gitService } from "@/services/gitService";
import { useExplorerSectionsStore } from "@/stores/useExplorerSectionsStore";

// --- i18n: t 直接回 key，便于断言 ---
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // 依赖链里有模块引入 "@/i18n"（其初始化调用 initReactI18next），mock 需一并提供
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

// --- WorkspaceTree stub ---
vi.mock("@/components/sidebar/WorkspaceTree", () => ({
  default: () => <div>workspace-tree-stub</div>,
}));

// --- 「最近」分区 stub：桩掉其会话索引 / 对话历史加载 ---
vi.mock("@/components/sidebar/RecentSessionsSection", () => ({
  default: () => <div>recent-sessions-stub</div>,
}));

// --- 任务面板 stub：keep-alive 常挂载，桩掉其 panes/status 订阅 ---
vi.mock("@/components/sidebar/TaskBoardView", () => ({
  default: ({ active }: { active: boolean }) => <div>task-board-stub:{String(active)}</div>,
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

function renderView() {
  render(<TooltipProvider><ExplorerView onOpenTerminal={vi.fn()} /></TooltipProvider>);
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
    useExplorerSectionsStore.setState({ explorerMode: "workspaces" });
  });

  it("defaults to workspaces mode: mode switch, search button, tree and recent", () => {
    renderView();
    // 标题文字已去掉，只作为区域的无障碍名保留
    expect(screen.queryByText("explorer.title")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "explorer.title" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "explorer.modeSwitch" })).toBeInTheDocument();
    expect(screen.getByText("workspace-tree-stub")).toBeVisible();
    expect(screen.getByText("recent-sessions-stub")).toBeVisible();
    // 标题旁只有「工作空间 | 任务」两档切换
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "explorer.modeWorkspaces" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("task-board-stub:false")).not.toBeVisible();
    // 「启动终端」主操作行已去掉（搜索面板的快捷操作 / 快捷键 / 标签栏 + 仍可启动）
    expect(screen.queryByRole("button", { name: /launchTerminal/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId("explorer-mode-trigger")).not.toBeInTheDocument();
    // 新建工作空间入口在工作空间头部，不再单独占一行
    expect(screen.queryByRole("button", { name: "newWorkspace" })).not.toBeInTheDocument();
  });

  it("opens the search panel from the header search button", () => {
    const onToggle = vi.fn();
    window.addEventListener(COMMAND_PALETTE_TOGGLE_EVENT, onToggle);
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "explorer.search" }));

    expect(onToggle).toHaveBeenCalledTimes(1);
    window.removeEventListener(COMMAND_PALETTE_TOGGLE_EVENT, onToggle);
  });

  it("switches to tasks mode: task board only, tree and recent hidden but still mounted", () => {
    renderView();
    fireEvent.click(screen.getByRole("tab", { name: "explorer.modeTasks" }));

    expect(useExplorerSectionsStore.getState().explorerMode).toBe("tasks");
    expect(screen.getByText("task-board-stub:true")).toBeVisible();
    expect(screen.getByText("workspace-tree-stub")).not.toBeVisible();
    expect(screen.getByText("recent-sessions-stub")).not.toBeVisible();
    // 搜索按钮两种模式都在
    expect(screen.getByRole("button", { name: "explorer.search" })).toBeVisible();
  });
});
