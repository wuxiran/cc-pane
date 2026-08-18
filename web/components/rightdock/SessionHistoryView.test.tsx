import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OpenTerminalOptions,
  SessionIndexEntry,
  SessionIndexListParams,
  Workspace,
} from "@/types";
import SessionHistoryView from "./SessionHistoryView";

const mocks = vi.hoisted(() => ({
  list: vi.fn<(params: SessionIndexListParams) => Promise<SessionIndexEntry[]>>(),
  refresh: vi.fn(),
  checkCodexRollout: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/services/sessionIndexService", () => ({
  sessionIndexService: {
    list: mocks.list,
    refresh: mocks.refresh,
    checkCodexRollout: mocks.checkCodexRollout,
  },
}));

vi.mock("sonner", () => ({
  toast: { warning: mocks.warning, error: mocks.error },
}));

const workspace: Workspace = {
  id: "workspace-1",
  name: "Workspace One",
  path: "D:/workspace",
  createdAt: "2026-07-25T00:00:00Z",
  projects: [
    { id: "project-1", path: "D:/workspace/alpha", alias: "Alpha" },
  ],
  defaultEnvironment: "local",
  wsl: { distro: "Ubuntu", remotePath: "/mnt/d/workspace" },
};

function session(overrides: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
  return {
    sessionId: "session-claude",
    cliTool: "claude",
    filePath: "/sessions/session-claude.jsonl",
    cwd: "D:/workspace/alpha/subdir",
    projectPathNorm: "d:/workspace/alpha",
    projectName: "Alpha",
    workspaceName: "Workspace One",
    firstPrompt: "Create the index",
    lastSummary: "Finished the index implementation",
    messageCount: 12,
    mtimeMs: Date.now() - 60_000,
    size: 1024,
    source: "local",
    wslDistro: null,
    updatedAt: "2026-07-25T00:00:00Z",
    ...overrides,
  };
}

function renderView(onOpenTerminal = vi.fn<(options: OpenTerminalOptions) => void>()) {
  const view = render(
    <SessionHistoryView
      workspaces={[workspace]}
      workspace={workspace}
      project={workspace.projects[0]}
      onOpenTerminal={onOpenTerminal}
    />,
  );
  return { ...view, onOpenTerminal };
}

describe("SessionHistoryView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([session()]);
    mocks.refresh.mockResolvedValue({
      rootsScanned: 2,
      filesSeen: 20,
      filesParsed: 1,
      filesSkipped: 19,
      bytesRead: 512,
    });
    mocks.checkCodexRollout.mockResolvedValue(true);
  });

  afterEach(() => vi.restoreAllMocks());

  it("默认按当前项目查询，并在三档 scope 间切换", async () => {
    renderView();

    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith({
      scope: "project",
      projectPath: "D:/workspace/alpha",
      limit: 100,
      offset: 0,
    }));

    fireEvent.click(screen.getByRole("button", { name: "当前工作空间" }));
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith({
      scope: "workspace",
      workspaceName: "Workspace One",
      limit: 100,
      offset: 0,
    }));

    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith({
      scope: "all",
      limit: 100,
      offset: 0,
    }));
  });

  it("当前项目 scope 随 RightDock 项目上下文变化", async () => {
    const { rerender } = renderView();
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({
      projectPath: "D:/workspace/alpha",
    })));

    const nextWorkspace: Workspace = {
      ...workspace,
      projects: [
        ...workspace.projects,
        { id: "project-2", path: "D:/workspace/beta", alias: "Beta" },
      ],
    };
    rerender(
      <SessionHistoryView
        workspaces={[nextWorkspace]}
        workspace={nextWorkspace}
        project={nextWorkspace.projects[1]}
        onOpenTerminal={vi.fn()}
      />,
    );

    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: "project",
      projectPath: "D:/workspace/beta",
      offset: 0,
    })));
  });

  it("搜索防抖 300ms，并将 CLI chip 与查询组合", async () => {
    renderView();
    await screen.findByText("Finished the index implementation");
    mocks.list.mockClear();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "rollout" } });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(mocks.list).not.toHaveBeenCalled();

    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({
      query: "rollout",
    })));

    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({
      query: "rollout",
      cliFilter: "codex",
    })));

    fireEvent.click(screen.getByRole("button", { name: "Pi" }));
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({
      query: "rollout",
      cliFilter: "pi",
    })));
  });

  it("以 100 条为一页追加加载更多结果", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => session({
      sessionId: `session-${index}`,
      lastSummary: `Summary ${index}`,
    }));
    mocks.list.mockImplementation(async (params) => (
      params.offset === 0 ? firstPage : [session({ sessionId: "session-more", lastSummary: "More" })]
    ));
    renderView();

    const loadMore = await screen.findByRole("button", { name: "加载更多" });
    fireEvent.click(loadMore);

    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({
      limit: 100,
      offset: 100,
    })));
    expect(await screen.findByText("More")).toBeInTheDocument();
  });

  it("手动刷新索引后重新读取当前组合查询", async () => {
    renderView();
    await screen.findByText("Finished the index implementation");
    mocks.list.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "刷新会话索引" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({
      scope: "project",
      projectPath: "D:/workspace/alpha",
    })));
  });

  it("用索引 cwd 和会话 ID 组装 Claude resume", async () => {
    const { onOpenTerminal } = renderView();
    await screen.findByText("Finished the index implementation");

    fireEvent.click(screen.getByRole("button", { name: "恢复" }));

    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({
      path: "D:/workspace/alpha/subdir",
      workspaceName: "Workspace One",
      cliTool: "claude",
      resumeId: "session-claude",
    }));
  });

  it("全部范围的会话使用其所属工作空间启动配置", async () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
    const otherWorkspace: Workspace = {
      id: "workspace-2",
      name: "Workspace Two",
      path: "E:/other",
      createdAt: "2026-07-25T00:00:00Z",
      projects: [{ id: "project-2", path: "E:/other/project", alias: "Other" }],
      defaultEnvironment: "wsl",
      wsl: { distro: "Debian", remotePath: "/mnt/e/other" },
    };
    mocks.list.mockResolvedValue([session({
      sessionId: "session-other",
      cwd: "/mnt/e/other/project/subdir",
      projectPathNorm: "e:/other/project",
      projectName: "Other",
      workspaceName: "Workspace Two",
      lastSummary: "Other workspace session",
      source: "wsl",
      wslDistro: "Debian",
    })]);
    const onOpenTerminal = vi.fn<(options: OpenTerminalOptions) => void>();
    render(
      <SessionHistoryView
        workspaces={[workspace, otherWorkspace]}
        workspace={workspace}
        project={workspace.projects[0]}
        onOpenTerminal={onOpenTerminal}
      />,
    );
    await screen.findByText("Other workspace session");

    fireEvent.click(screen.getByRole("button", { name: "恢复" }));

    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({
      path: "/mnt/e/other/project/subdir",
      workspaceName: "Workspace Two",
      workspacePath: "E:/other",
      resumeId: "session-other",
      wsl: {
        distro: "Debian",
        remotePath: "/mnt/e/other/project/subdir",
      },
    }));
  });

  it("Codex rollout 无效时不启动，并禁用入口显示告警", async () => {
    mocks.list.mockResolvedValue([session({
      sessionId: "019f937c-364f-7440-a017-b89c15772e1c",
      cliTool: "codex",
      source: "wsl",
      cwd: "/mnt/d/workspace/alpha",
      wslDistro: "Ubuntu",
      lastSummary: "Codex session",
    })]);
    mocks.checkCodexRollout.mockResolvedValue(false);
    const { onOpenTerminal } = renderView();
    await screen.findByText("Codex session");

    fireEvent.click(screen.getByRole("button", { name: "恢复" }));

    await waitFor(() => expect(mocks.checkCodexRollout).toHaveBeenCalledWith(
      "019f937c-364f-7440-a017-b89c15772e1c",
      "Ubuntu",
    ));
    expect(onOpenTerminal).not.toHaveBeenCalled();
    expect(await screen.findByText("Codex 会话文件已不存在，无法恢复")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复" })).toBeDisabled();
    expect(mocks.warning).toHaveBeenCalled();
  });

  it("Codex rollout 有效时携带 WSL 恢复上下文启动", async () => {
    mocks.list.mockResolvedValue([session({
      sessionId: "019f937c-364f-7440-a017-b89c15772e1c",
      cliTool: "codex",
      source: "wsl",
      cwd: "/mnt/d/workspace/alpha/subdir",
      wslDistro: "Ubuntu",
      lastSummary: "Resume Codex",
    })]);
    const { onOpenTerminal } = renderView();
    await screen.findByText("Resume Codex");

    fireEvent.click(screen.getByRole("button", { name: "恢复" }));

    await waitFor(() => expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({
      path: "/mnt/d/workspace/alpha/subdir",
      cliTool: "codex",
      resumeId: "019f937c-364f-7440-a017-b89c15772e1c",
      wsl: {
        distro: "Ubuntu",
        remotePath: "/mnt/d/workspace/alpha/subdir",
      },
    })));
  });
});
