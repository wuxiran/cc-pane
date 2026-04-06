import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProjectListView from "./ProjectListView";
import { createTestWorkspace, createTestWorkspaceProject, resetTestDataCounter } from "@/test/utils/testData";
import { useDialogStore, useProvidersStore, useSshMachinesStore } from "@/stores";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/hooks/useCliTools", () => ({
  useCliTools: () => ({
    tools: [
      { id: "claude", displayName: "Claude" },
      { id: "codex", displayName: "Codex" },
      { id: "gemini", displayName: "Gemini" },
      { id: "opencode", displayName: "OpenCode" },
    ],
  }),
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
    useProvidersStore.setState({
      providers: [
        { id: "provider-claude", name: "Claude Provider", providerType: "anthropic", isDefault: false },
        { id: "provider-gemini", name: "Gemini Provider", providerType: "gemini", isDefault: false },
        { id: "provider-opencode", name: "OpenCode Provider", providerType: "opencode", isDefault: false },
      ],
    });
    useSshMachinesStore.setState({ machines: [] });
    useDialogStore.setState({
      localHistoryOpen: false,
      localHistoryProjectPath: "",
      localHistoryFilePath: "",
      todoOpen: false,
      todoScope: "",
      todoScopeRef: "",
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

  it("默认环境为 local 时项目右键 Codex 走本地启动", async () => {
    const user = userEvent.setup();
    const onOpenTerminal = vi.fn();
    const workspace = createTestWorkspace({
      defaultEnvironment: "local",
      path: "D:/workspace-root",
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
    await user.click(await screen.findByRole("menuitem", { name: "Codex" }));

    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({
      path: "D:/workspace-root/apps/api",
      workspacePath: "D:/workspace-root",
      cliTool: "codex",
    }));
    expect(onOpenTerminal.mock.calls[0]?.[0]?.wsl).toBeUndefined();
  });

  it("默认环境为 wsl 时项目右键 Codex 自动走 WSL", async () => {
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
    await user.click(await screen.findByRole("menuitem", { name: "Codex" }));

    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({
      path: "D:/workspace-root/apps/api",
      workspacePath: "D:/workspace-root",
      cliTool: "codex",
      wsl: expect.objectContaining({
        remotePath: "/mnt/d/workspace-root/apps/api",
      }),
    }));
  });

  it("默认环境为 wsl 时 Claude、Gemini、OpenCode 仍显示 provider 子菜单入口", async () => {
    const workspace = createTestWorkspace({
      defaultEnvironment: "wsl",
      path: "D:/workspace-root",
      providerId: "provider-claude",
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
    expect(await screen.findByRole("menuitem", { name: "Claude" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Gemini" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "OpenCode" })).toBeVisible();
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
});
