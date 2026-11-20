import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ExplorerView from "./ExplorerView";
import { COMMAND_PALETTE_TOGGLE_EVENT } from "@/lib/commands/paletteEvents";
import { gitService } from "@/services/gitService";
import type { OpenTerminalOptions } from "@/types";

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

// --- 「最近」分区 stub：桩掉其会话索引 / 对话历史加载 ---
vi.mock("@/components/sidebar/RecentSessionsSection", () => ({
  default: () => <div>recent-sessions-stub</div>,
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

describe("ExplorerView", () => {
  beforeEach(() => {
    vi.mocked(gitService.getRepoInfo).mockResolvedValue({
      state: "notARepo",
      repoRoot: null,
      branch: null,
      hasChanges: null,
      message: null,
    });
  });

  it("is just a title, a search button and the workspace tree", () => {
    render(<TooltipProvider><ExplorerView onOpenTerminal={vi.fn()} /></TooltipProvider>);
    expect(screen.getByText("explorer.title")).toBeVisible();
    expect(screen.getByText("workspace-tree-stub")).toBeVisible();
    expect(screen.getByText("recent-sessions-stub")).toBeVisible();
    // 会话进了搜索面板、通讯录进了左侧图标栏：标题旁不再有视图切换
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    // 「启动终端」主操作行已去掉（搜索面板的快捷操作 / 快捷键 / 标签栏 + 仍可启动）
    expect(screen.queryByRole("button", { name: /launchTerminal/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId("explorer-mode-trigger")).not.toBeInTheDocument();
  });

  it("opens the search panel from the header search button", () => {
    const onToggle = vi.fn();
    window.addEventListener(COMMAND_PALETTE_TOGGLE_EVENT, onToggle);
    render(<TooltipProvider><ExplorerView onOpenTerminal={vi.fn()} /></TooltipProvider>);

    fireEvent.click(screen.getByRole("button", { name: "explorer.search" }));

    expect(onToggle).toHaveBeenCalledTimes(1);
    window.removeEventListener(COMMAND_PALETTE_TOGGLE_EVENT, onToggle);
  });

  it("forwards onOpenTerminal from the workspace tree", () => {
    const onOpenTerminal = vi.fn();
    render(<TooltipProvider><ExplorerView onOpenTerminal={onOpenTerminal} /></TooltipProvider>);
    fireEvent.click(screen.getByText("workspace-tree-stub"));
    expect(onOpenTerminal).toHaveBeenCalledWith({ path: "/tmp/from-tree" });
  });

  it("no longer has a separate new-workspace row (it lives in the workspace header)", () => {
    render(<TooltipProvider><ExplorerView onOpenTerminal={vi.fn()} /></TooltipProvider>);
    expect(screen.queryByRole("button", { name: "newWorkspace" })).not.toBeInTheDocument();
  });
});
