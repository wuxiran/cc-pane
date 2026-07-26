import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProjectListView from "./ProjectListView";
import { createTestSettings, createTestWorkspace, createTestWorkspaceProject, resetTestDataCounter } from "@/test/utils/testData";
import { useDialogStore, useSettingsStore, useSshMachinesStore } from "@/stores";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/services/specService", () => ({
  specService: {
    list: vi.fn(async () => []),
    create: vi.fn(async () => undefined),
  },
}));

describe("ProjectListView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTestDataCounter();
    useSshMachinesStore.setState({ machines: [] });
    useDialogStore.setState({
      localHistoryOpen: false,
      localHistoryProjectPath: "",
      localHistoryFilePath: "",
      todoOpen: false,
      todoScope: "",
      todoScopeRef: "",
    });
    useSettingsStore.setState({
      settings: createTestSettings(),
      loading: false,
    });
    Object.defineProperty(window.navigator, "platform", {
      value: "Win32",
      configurable: true,
    });
  });

  it("WSL UNC 路径项目显示 WSL badge", () => {
    const workspace = createTestWorkspace({
      projects: [
        createTestWorkspaceProject({
          alias: "wsl-project",
          path: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo",
        }),
      ],
    });

    render(
      <ProjectListView
        projects={workspace.projects}
        ws={workspace}
        gitBranches={{}}
        onOpenTerminal={vi.fn()}
        onRemoveProject={vi.fn()}
        onSetProjectAlias={vi.fn()}
        onImportProject={vi.fn()}
        onMigrateProject={vi.fn()}
        onOpenWorktreeManager={vi.fn()}
      />
    );

    expect(screen.getByText("wsl-project")).toBeVisible();
    expect(screen.getByText("WSL")).toBeVisible();
  });

  it("本地项目和 SSH 项目保留原有 badge", () => {
    const workspace = createTestWorkspace({
      projects: [
        createTestWorkspaceProject({
          alias: "local-project",
          path: "D:/workspace/local-project",
        }),
        createTestWorkspaceProject({
          alias: "ssh-project",
          path: "/ignored/for/ssh",
          ssh: {
            host: "devbox.local",
            port: 22,
            user: "dev",
            remotePath: "/home/dev/repo",
          },
        }),
      ],
    });

    render(
      <ProjectListView
        projects={workspace.projects}
        ws={workspace}
        gitBranches={{}}
        onOpenTerminal={vi.fn()}
        onRemoveProject={vi.fn()}
        onSetProjectAlias={vi.fn()}
        onImportProject={vi.fn()}
        onMigrateProject={vi.fn()}
        onOpenWorktreeManager={vi.fn()}
      />
    );

    expect(screen.getByText("local-project")).toBeVisible();
    expect(screen.getByText("LOCAL")).toBeVisible();
    expect(screen.getByText("ssh-project")).toBeVisible();
    expect(screen.getByText("SSH")).toBeVisible();
  });

  it("运行时异常项目不会让项目列表渲染崩溃", () => {
    const validProject = createTestWorkspaceProject({
      alias: "valid-project",
      path: "D:/workspace/valid-project",
    });
    const projects = [
      validProject,
      { id: "missing-path" },
      null,
    ] as unknown as ReturnType<typeof createTestWorkspaceProject>[];
    const workspace = createTestWorkspace({ projects });

    render(
      <ProjectListView
        projects={projects}
        ws={workspace}
        gitBranches={{}}
        onOpenTerminal={vi.fn()}
        onRemoveProject={vi.fn()}
        onSetProjectAlias={vi.fn()}
        onImportProject={vi.fn()}
        onMigrateProject={vi.fn()}
        onOpenWorktreeManager={vi.fn()}
      />
    );

    expect(screen.getByText("valid-project")).toBeVisible();
    expect(screen.getByText("已隐藏 2 个异常项目")).toBeVisible();
  });

  it("项目菜单直接显示 CLI 入口", async () => {
    const workspace = createTestWorkspace({
      projects: [
        createTestWorkspaceProject({
          alias: "local-project",
          path: "D:/workspace-root/apps/api",
        }),
      ],
    });

    render(
      <ProjectListView
        projects={workspace.projects}
        ws={workspace}
        gitBranches={{}}
        onOpenTerminal={vi.fn()}
        onRemoveProject={vi.fn()}
        onSetProjectAlias={vi.fn()}
        onImportProject={vi.fn()}
        onMigrateProject={vi.fn()}
        onOpenWorktreeManager={vi.fn()}
      />
    );

    fireEvent.contextMenu(screen.getByText("local-project"));
    // 常用项（默认 claude/codex）顶层可见
    expect(await screen.findByRole("menuitem", { name: "Claude Code" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Codex CLI" })).toBeVisible();
    // 其余 CLI 折叠进"更多启动方式"（issue #36）
    expect(screen.queryByRole("menuitem", { name: "Kimi CLI" })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.hover(screen.getByRole("menuitem", { name: /更多启动方式|More launch options/ }));
    expect(await screen.findByRole("menuitem", { name: "Kimi CLI" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "GLM CLI" })).toBeVisible();
  });

  it("默认环境为 wsl 时项目右键 Codex 普通项跟随默认环境", async () => {
    const user = userEvent.setup();
    const onOpenTerminal = vi.fn();
    const workspace = createTestWorkspace({
      defaultEnvironment: "wsl",
      path: "D:/workspace-root",
      wsl: {
        distro: "Ubuntu",
        remotePath: "/mnt/d/workspace-root",
      },
      projects: [
        createTestWorkspaceProject({
          alias: "local-project",
          path: "D:/workspace-root/apps/api",
        }),
      ],
    });

    render(
      <ProjectListView
        projects={workspace.projects}
        ws={workspace}
        gitBranches={{}}
        onOpenTerminal={onOpenTerminal}
        onRemoveProject={vi.fn()}
        onSetProjectAlias={vi.fn()}
        onImportProject={vi.fn()}
        onMigrateProject={vi.fn()}
        onOpenWorktreeManager={vi.fn()}
      />
    );

    fireEvent.contextMenu(screen.getByText("local-project"));
    await user.click(await screen.findByRole("menuitem", { name: "Codex CLI" }));

    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({
      path: "D:/workspace-root/apps/api",
      workspacePath: "D:/workspace-root",
      cliTool: "codex",
      wsl: expect.objectContaining({
        remotePath: "/mnt/d/workspace-root/apps/api",
      }),
    }));
  });

  it("默认环境为 wsl 时项目右键提供显式 WSL CLI 入口", async () => {
    const workspace = createTestWorkspace({
      defaultEnvironment: "wsl",
      path: "D:/workspace-root",
      wsl: {
        distro: "Ubuntu",
        remotePath: "/mnt/d/workspace-root",
      },
      projects: [
        createTestWorkspaceProject({
          alias: "local-project",
          path: "D:/workspace-root/apps/api",
        }),
      ],
    });

    render(
      <ProjectListView
        projects={workspace.projects}
        ws={workspace}
        gitBranches={{}}
        onOpenTerminal={vi.fn()}
        onRemoveProject={vi.fn()}
        onSetProjectAlias={vi.fn()}
        onImportProject={vi.fn()}
        onMigrateProject={vi.fn()}
        onOpenWorktreeManager={vi.fn()}
      />
    );

    fireEvent.contextMenu(screen.getByText("local-project"));
    const user = userEvent.setup();
    await user.hover(
      await screen.findByRole("menuitem", { name: /更多启动方式|More launch options/ }),
    );
    expect(await screen.findByRole("menuitem", { name: /Codex CLI.*WSL/ })).toBeVisible();
  });

  it("默认环境为 wsl 时显式 WSL CLI 项也走 WSL", async () => {
    const user = userEvent.setup();
    const onOpenTerminal = vi.fn();
    const workspace = createTestWorkspace({
      defaultEnvironment: "wsl",
      path: "D:/workspace-root",
      wsl: {
        distro: "Ubuntu",
        remotePath: "/mnt/d/workspace-root",
      },
      projects: [
        createTestWorkspaceProject({
          alias: "local-project",
          path: "D:/workspace-root/apps/api",
        }),
      ],
    });

    render(
      <ProjectListView
        projects={workspace.projects}
        ws={workspace}
        gitBranches={{}}
        onOpenTerminal={onOpenTerminal}
        onRemoveProject={vi.fn()}
        onSetProjectAlias={vi.fn()}
        onImportProject={vi.fn()}
        onMigrateProject={vi.fn()}
        onOpenWorktreeManager={vi.fn()}
      />
    );

    fireEvent.contextMenu(screen.getByText("local-project"));
    await user.hover(
      await screen.findByRole("menuitem", { name: /更多启动方式|More launch options/ }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: /Codex CLI.*WSL/ }));

    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({
      path: "D:/workspace-root/apps/api",
      workspacePath: "D:/workspace-root",
      cliTool: "codex",
      wsl: expect.objectContaining({
        remotePath: "/mnt/d/workspace-root/apps/api",
      }),
    }));
  });

  it("does not render inline favorite launch buttons under project rows", () => {
    useSettingsStore.setState({
      settings: createTestSettings({
        general: {
          ...createTestSettings().general,
          launchFavorites: ["terminal-default", "terminal-wsl"],
        },
      }),
      loading: false,
    });
    const workspace = createTestWorkspace({
      defaultEnvironment: "wsl",
      path: "D:/workspace-root",
      wsl: {
        distro: "Ubuntu",
        remotePath: "/mnt/d/workspace-root",
      },
      projects: [
        createTestWorkspaceProject({
          alias: "local-project",
          path: "D:/workspace-root/apps/api",
        }),
      ],
    });

    render(
      <ProjectListView
        projects={workspace.projects}
        ws={workspace}
        gitBranches={{}}
        onOpenTerminal={vi.fn()}
        onRemoveProject={vi.fn()}
        onSetProjectAlias={vi.fn()}
        onImportProject={vi.fn()}
        onMigrateProject={vi.fn()}
        onOpenWorktreeManager={vi.fn()}
      />
    );

    expect(screen.queryByText(/常用|Favorites/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /打开终端.*WSL|Open Terminal.*WSL/i })).not.toBeInTheDocument();
  });

  it("默认环境为 wsl 时项目默认打开终端也走 WSL", async () => {
    const user = userEvent.setup();
    const onOpenTerminal = vi.fn();
    const workspace = createTestWorkspace({
      defaultEnvironment: "wsl",
      path: "D:/workspace-root",
      wsl: {
        remotePath: "/mnt/d/workspace-root",
      },
      projects: [
        createTestWorkspaceProject({
          alias: "local-project",
          path: "D:/workspace-root/apps/api",
        }),
      ],
    });

    render(
      <ProjectListView
        projects={workspace.projects}
        ws={workspace}
        gitBranches={{}}
        onOpenTerminal={onOpenTerminal}
        onRemoveProject={vi.fn()}
        onSetProjectAlias={vi.fn()}
        onImportProject={vi.fn()}
        onMigrateProject={vi.fn()}
        onOpenWorktreeManager={vi.fn()}
      />
    );

    fireEvent.contextMenu(screen.getByText("local-project"));
    await user.click(await screen.findByRole("menuitem", { name: "打开终端" }));

    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({
      path: "D:/workspace-root/apps/api",
      wsl: { remotePath: "/mnt/d/workspace-root/apps/api" },
    }));
  });

  describe("worktree 分组", () => {
    const MAIN = "D:\\repo";
    const WT = "D:\\repo-wt-a";
    const fullList = [
      { path: MAIN, branch: "main", commit: "aaa1111", isMain: true },
      { path: WT, branch: "feature/a", commit: "bbb2222", isMain: false },
    ];

    function renderWithWorktrees(worktreeCache: Record<string, typeof fullList>) {
      const workspace = createTestWorkspace({
        projects: [
          createTestWorkspaceProject({ alias: "main-repo", path: MAIN }),
          createTestWorkspaceProject({ alias: "wt-a", path: WT }),
        ],
      });
      render(
        <ProjectListView
          projects={workspace.projects}
          ws={workspace}
          gitBranches={{}}
          worktreeCache={worktreeCache}
          onOpenTerminal={vi.fn()}
          onRemoveProject={vi.fn()}
          onSetProjectAlias={vi.fn()}
          onImportProject={vi.fn()}
          onMigrateProject={vi.fn()}
          onOpenWorktreeManager={vi.fn()}
        />
      );
      return workspace;
    }

    it("默认收起：只渲染主仓库行，worktree 子行不可见", () => {
      renderWithWorktrees({ [MAIN]: fullList, [WT]: fullList });

      expect(screen.getByText("main-repo")).toBeInTheDocument();
      expect(screen.queryByText("wt-a")).not.toBeInTheDocument();
    });

    it("点展开箭头后 worktree 子行出现并显示分支名", async () => {
      const user = userEvent.setup();
      renderWithWorktrees({ [MAIN]: fullList, [WT]: fullList });

      await user.click(screen.getByRole("button", { name: /展开\/收起 worktree|Toggle worktrees/i }));

      expect(screen.getByText("wt-a")).toBeInTheDocument();
      expect(screen.getByText("feature/a")).toBeInTheDocument();
    });

    // 回归护栏：没有 worktree 数据时必须与改造前的平铺完全一致
    it("worktreeCache 为空时保持平铺", () => {
      renderWithWorktrees({});

      expect(screen.getByText("main-repo")).toBeInTheDocument();
      expect(screen.getByText("wt-a")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /展开\/收起 worktree|Toggle worktrees/i }))
        .not.toBeInTheDocument();
    });
  });

  describe("失效项目", () => {
    function renderWithStatus(onCleanup?: () => void) {
      const missing = createTestWorkspaceProject({ alias: "gone", path: "D:\\gone" });
      const alive = createTestWorkspaceProject({ alias: "alive", path: "D:\\alive" });
      const workspace = createTestWorkspace({ projects: [missing, alive] });
      render(
        <ProjectListView
          projects={workspace.projects}
          ws={workspace}
          gitBranches={{}}
          projectPathStatus={{ [missing.id]: "missing", [alive.id]: "present" }}
          onOpenTerminal={vi.fn()}
          onRemoveProject={vi.fn()}
          onSetProjectAlias={vi.fn()}
          onImportProject={vi.fn()}
          onMigrateProject={vi.fn()}
          onOpenWorktreeManager={vi.fn()}
          onCleanupMissingProjects={onCleanup}
        />
      );
      return workspace;
    }

    it("路径不存在的项目显示红字标记，正常项目不受影响", () => {
      renderWithStatus(vi.fn());

      expect(screen.getByText("项目路径不存在")).toBeInTheDocument();
      expect(screen.getByText("gone")).toHaveClass("line-through");
      expect(screen.getByText("alive")).not.toHaveClass("line-through");
    });

    it("有失效项目时显示清理横幅并可触发清理", async () => {
      const user = userEvent.setup();
      const onCleanup = vi.fn();
      renderWithStatus(onCleanup);

      expect(screen.getByText("1 个项目路径已不存在")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "清理失效项目" }));
      expect(onCleanup).toHaveBeenCalledTimes(1);
    });

    it("失效项目的右键菜单裁剪掉必然失败的入口", async () => {
      renderWithStatus(vi.fn());

      fireEvent.contextMenu(screen.getByText("gone"));

      expect(await screen.findByRole("menuitem", { name: "移除项目" })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: "Worktree 管理" })).not.toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: "文件历史" })).not.toBeInTheDocument();
    });
  });
});
