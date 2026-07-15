import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useLaunchProfilesStore, useProvidersStore, useSettingsStore } from "@/stores";
import { createTestProvider, createTestSettings, createTestWorkspace, resetTestDataCounter } from "@/test/utils/testData";
import type { LaunchProfile, Workspace } from "@/types";
import WorkspaceItem from "./WorkspaceItem";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/services", () => ({
  projectCliHooksService: {
    getStatus: vi.fn(async () => []),
    setHookEnabled: vi.fn(async () => undefined),
  },
}));

vi.mock("./AddSshProjectDialog", () => ({
  default: () => null,
}));

function renderWorkspaceItem(
  defaultEnvironment: "local" | "wsl" = "local",
  expanded = false,
  workspaceOverrides: Partial<Workspace> = {},
) {
  const onOpenTerminal = vi.fn();
  const onOpenEnvironment = vi.fn();
  const ws = createTestWorkspace({
    name: "workspace-alpha",
    path: "D:/workspace-alpha",
    defaultEnvironment,
    providerId: "provider-codex",
    ...workspaceOverrides,
  });

  render(
    <TooltipProvider>
      <WorkspaceItem
        ws={ws}
        expanded={expanded}
        onExpand={vi.fn()}
        onOpenTerminal={onOpenTerminal}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onSetAlias={vi.fn()}
        onImportProject={vi.fn()}
        onScanImport={vi.fn()}
        onGitClone={vi.fn()}
        onSetPath={vi.fn()}
        onClearPath={vi.fn()}
        onOpenEnvironment={onOpenEnvironment}
        onOpenInFileBrowser={vi.fn()}
      >
        <div>children</div>
      </WorkspaceItem>
    </TooltipProvider>,
  );

  return { onOpenEnvironment, onOpenTerminal, ws };
}

function createLaunchProfile(overrides: Partial<LaunchProfile> = {}): LaunchProfile {
  return {
    id: "profile-1",
    name: "Codex Fast",
    alias: null,
    description: null,
    providerId: null,
    targetTools: ["codex"],
    targetRuntime: null,
    mcpPolicy: {
      mode: "default",
      enabledServerIds: [],
      disabledServerIds: [],
      includeCcpanesMcp: true,
      includeSharedMcp: true,
    },
    skillPolicy: {
      mode: "core",
      enabledSkillIds: [],
      disabledSkillIds: [],
      profileSkills: [],
      includeProjectSkills: true,
      includeExternalClaudeSkills: true,
      includeExternalCodexSkills: true,
      includeExternalPluginSkills: true,
      target: "session",
    },
    isDefault: false,
    createdAt: "2026-05-03T00:00:00Z",
    updatedAt: "2026-05-03T00:00:00Z",
    ...overrides,
  };
}

describe("WorkspaceItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTestDataCounter();
    useProvidersStore.setState({
      providers: [
        createTestProvider({
          id: "provider-claude",
          name: "Claude Provider",
          providerType: "anthropic",
        }),
        createTestProvider({
          id: "provider-codex",
          name: "Codex Provider",
          providerType: "open_ai",
        }),
      ],
    });
    useSettingsStore.setState({
      settings: createTestSettings(),
      loading: false,
    });
    useLaunchProfilesStore.setState({
      profiles: [],
      loading: false,
    });
    Object.defineProperty(window.navigator, "platform", {
      value: "Win32",
      configurable: true,
    });
  });

  it("projects 运行时缺失时仍渲染工作空间并显示 0", () => {
    renderWorkspaceItem("local", false, {
      projects: undefined as unknown as Workspace["projects"],
    });

    expect(screen.getByText("workspace-alpha")).toBeVisible();
    expect(screen.getByText("0")).toBeVisible();
  });

  it("兼容旧版常用启动项配置且不触发渲染循环", async () => {
    useSettingsStore.setState({
      settings: createTestSettings({
        general: {
          ...createTestSettings().general,
          launchFavorites: ["terminal-default", "claude-local", "codex-local"],
        },
      }),
      loading: false,
    });

    renderWorkspaceItem("local");
    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));

    expect((await screen.findAllByRole("menuitem", { name: "Claude Code" })).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("menuitem", { name: "Codex CLI" }).length).toBeGreaterThan(0);
  });

  it("shows the workspace environment entry directly in the workspace context menu", async () => {
    renderWorkspaceItem("local");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));

    expect(await screen.findByRole("menuitem", { name: /编辑运行环境|Edit Environment/i })).toBeVisible();
  });

  it("opens the workspace environment sheet from the workspace context menu", async () => {
    const { onOpenEnvironment, ws } = renderWorkspaceItem("local");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /编辑运行环境|Edit Environment/i }));

    expect(onOpenEnvironment).toHaveBeenCalledWith(ws);
  });

  it("shows CLI entries in the workspace launch menu", async () => {
    const user = userEvent.setup();
    renderWorkspaceItem("local");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));

    // 常用项（默认 claude/codex）顶层可见
    expect((await screen.findAllByRole("menuitem", { name: "Claude Code" })).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("menuitem", { name: "Codex CLI" }).length).toBeGreaterThan(0);
    // 其余 CLI 折叠进"更多启动方式"（issue #36）
    expect(screen.queryByRole("menuitem", { name: "Kimi CLI" })).not.toBeInTheDocument();
    await user.hover(screen.getByRole("menuitem", { name: /更多启动方式|More launch options/ }));
    expect(await screen.findByRole("menuitem", { name: "Gemini CLI" })).toBeVisible();
    expect(screen.getAllByRole("menuitem", { name: "Kimi CLI" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("menuitem", { name: "GLM CLI" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("menuitem", { name: "OpenCode" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("menuitem", { name: "Cursor CLI" }).length).toBeGreaterThan(0);
    expect(screen.queryByText("Claude Provider")).not.toBeInTheDocument();
  });

  it("does not show the old provider launch submenu", async () => {
    renderWorkspaceItem("local");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));

    expect(screen.queryByRole("menuitem", { name: /Provider 启动|Choose Provider/i })).not.toBeInTheDocument();
  });

  it("renders favorite launch actions at the top of the workspace context menu", async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({
      settings: createTestSettings({
        general: {
          ...createTestSettings().general,
          launchFavorites: ["terminal-default", "codex-local"],
        },
      }),
      loading: false,
    });
    const { onOpenTerminal } = renderWorkspaceItem("local");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    await user.hover((await screen.findAllByRole("menuitem", { name: /Codex CLI.*(Local|本机)/ }))[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: /使用默认运行配置|Launch with Default Profile/i }));

    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({
      path: "D:/workspace-alpha",
      cliTool: "codex",
    }));
  });

  it("shows the hide non-favorite launch toggle in the workspace context menu", async () => {
    useSettingsStore.setState({
      settings: createTestSettings({
        general: {
          ...createTestSettings().general,
          launchFavorites: ["terminal-default"],
        },
      }),
      loading: false,
    });

    renderWorkspaceItem("local");
    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    await userEvent.setup().hover(await screen.findByRole("menuitem", { name: /显示在常用|Show in favorites/i }));

    expect(await screen.findByRole("menuitemcheckbox", { name: /隐藏非常用菜单|Hide non-favorite/i })).toBeVisible();
  });

  it("hides non-favorite launch items when the toggle is enabled", async () => {
    useSettingsStore.setState({
      settings: createTestSettings({
        general: {
          ...createTestSettings().general,
          launchFavorites: ["terminal-default", "codex-local"],
          hideNonFavoriteLaunchActions: true,
        },
      }),
      loading: false,
    });

    renderWorkspaceItem("local");
    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));

    expect(screen.queryByRole("menuitem", { name: "Gemini CLI" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Kimi CLI" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "打开终端" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: /Codex CLI.*(Local|本机)/ })).toBeVisible();
  });

  it("supports terminal WSL as a workspace favorite launch action in the context menu", async () => {
    useSettingsStore.setState({
      settings: createTestSettings({
        general: {
          ...createTestSettings().general,
          launchFavorites: ["terminal-wsl"],
          hideNonFavoriteLaunchActions: true,
        },
      }),
      loading: false,
    });
    const { onOpenTerminal } = renderWorkspaceItem("wsl");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^打开终端（WSL）$|^Open Terminal \(WSL\)$/i }));

    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({
      path: "D:/workspace-alpha",
      wsl: {
        remotePath: "/mnt/d/workspace-alpha",
      },
    }));
  });

  it("opens Codex with the workspace default environment", async () => {
    const user = userEvent.setup();
    const { onOpenTerminal } = renderWorkspaceItem("wsl");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    await user.hover((await screen.findAllByRole("menuitem", { name: "Codex CLI" }))[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: /使用默认运行配置|Launch with Default Profile/i }));

    const call = onOpenTerminal.mock.calls[0]?.[0];
    expect(call).toEqual(expect.objectContaining({
      path: "D:/workspace-alpha",
      cliTool: "codex",
      wsl: {
        remotePath: "/mnt/d/workspace-alpha",
      },
    }));
    expect(call?.providerId).toBeUndefined();
    expect(call?.launchProfileId).toBeUndefined();
  });

  it("launches OpenCode when clicking the workspace CLI menu item directly", async () => {
    const user = userEvent.setup();
    const { onOpenTerminal } = renderWorkspaceItem("local");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    await user.hover(
      await screen.findByRole("menuitem", { name: /更多启动方式|More launch options/ }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "OpenCode" }));

    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({
      path: "D:/workspace-alpha",
      cliTool: "opencode",
    }));
  });

  it("shows explicit WSL CLI entries when the workspace default environment is wsl", async () => {
    const user = userEvent.setup();
    renderWorkspaceItem("wsl");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    await user.hover(
      await screen.findByRole("menuitem", { name: /更多启动方式|More launch options/ }),
    );

    expect(await screen.findByRole("menuitem", { name: /Codex CLI.*WSL/ })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: /Claude Code.*WSL/ })).toBeVisible();
  });

  it("opens Codex through WSL when choosing the explicit WSL entry", async () => {
    const user = userEvent.setup();
    const { onOpenTerminal } = renderWorkspaceItem("wsl");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    await user.hover(
      await screen.findByRole("menuitem", { name: /更多启动方式|More launch options/ }),
    );
    // jsdom 下三层嵌套子菜单 hover 不触发展开，用 Radix 键盘导航展开
    const codexWslTrigger = await screen.findByRole("menuitem", { name: /Codex CLI.*WSL/ });
    codexWslTrigger.focus();
    fireEvent.keyDown(codexWslTrigger, { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /使用默认运行配置|Launch with Default Profile/i }));

    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({
      path: "D:/workspace-alpha",
      cliTool: "codex",
      wsl: {
        remotePath: "/mnt/d/workspace-alpha",
      },
    }));
  });

  it("hides the workspace provider badge when default environment is wsl", () => {
    renderWorkspaceItem("wsl");

    expect(screen.queryByText("Codex Provider")).not.toBeInTheDocument();
  });

  it("keeps shell open terminal following the default environment", async () => {
    const user = userEvent.setup();
    const { onOpenTerminal } = renderWorkspaceItem("wsl");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    await user.click((await screen.findAllByRole("menuitem", { name: "打开终端" }))[0]);

    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({
      path: "D:/workspace-alpha",
      wsl: {
        remotePath: "/mnt/d/workspace-alpha",
      },
    }));
  });

  it("launches a workspace with an explicitly selected launch profile", async () => {
    const user = userEvent.setup();
    useLaunchProfilesStore.setState({
      profiles: [
        createLaunchProfile({ id: "profile-codex-fast", name: "Codex Fast" }),
        createLaunchProfile({ id: "profile-claude", name: "Claude Plan", targetTools: ["claude"] }),
      ],
      loading: false,
    });
    const { onOpenTerminal } = renderWorkspaceItem("local");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    await user.hover((await screen.findAllByRole("menuitem", { name: "Codex CLI" }))[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Codex Fast/ }));

    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({
      path: "D:/workspace-alpha",
      cliTool: "codex",
      launchProfileId: "profile-codex-fast",
    }));
    expect(screen.queryByRole("menuitem", { name: "Claude Plan" })).not.toBeInTheDocument();
  });

  it("filters launch profiles by local and wsl runtime", async () => {
    const user = userEvent.setup();
    useLaunchProfilesStore.setState({
      profiles: [
        createLaunchProfile({ id: "profile-codex-local", name: "Codex Local", targetRuntime: "local" }),
        createLaunchProfile({ id: "profile-codex-wsl", name: "Codex WSL", targetRuntime: "wsl" }),
      ],
      loading: false,
    });
    renderWorkspaceItem("local");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    await user.hover((await screen.findAllByRole("menuitem", { name: "Codex CLI" }))[0]);

    expect(await screen.findByRole("menuitem", { name: /Codex Local/ })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: /Codex WSL/ })).not.toBeInTheDocument();
  });

  it("filters default Codex profiles with the workspace Codex CLI default environment", async () => {
    const user = userEvent.setup();
    useLaunchProfilesStore.setState({
      profiles: [
        createLaunchProfile({ id: "profile-codex-local", name: "Codex Local", targetRuntime: "local" }),
        createLaunchProfile({ id: "profile-codex-wsl", name: "Codex WSL", targetRuntime: "wsl" }),
      ],
      loading: false,
    });
    renderWorkspaceItem("local", false, {
      cliEnvironmentDefaults: {
        codex: "wsl",
      },
    });

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    await user.hover((await screen.findAllByRole("menuitem", { name: "Codex CLI" }))[0]);

    expect(await screen.findByRole("menuitem", { name: /Codex WSL/ })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: /Codex Local/ })).not.toBeInTheDocument();
  });

  it("uses the Codex CLI default environment for favorite default actions", async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({
      settings: createTestSettings({
        general: {
          ...createTestSettings().general,
          launchFavorites: ["codex-default"],
          hideNonFavoriteLaunchActions: true,
        },
      }),
      loading: false,
    });
    useLaunchProfilesStore.setState({
      profiles: [
        createLaunchProfile({ id: "profile-codex-local", name: "Codex Local", targetRuntime: "local" }),
        createLaunchProfile({ id: "profile-codex-wsl", name: "Codex WSL", targetRuntime: "wsl" }),
      ],
      loading: false,
    });
    renderWorkspaceItem("local", false, {
      cliEnvironmentDefaults: {
        codex: "wsl",
      },
    });

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    await user.hover(await screen.findByRole("menuitem", { name: "Codex CLI" }));

    expect(await screen.findByRole("menuitem", { name: /Codex WSL/ })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: /Codex Local/ })).not.toBeInTheDocument();
  });

  it("launches a wsl-specific Codex profile from the WSL menu", async () => {
    const user = userEvent.setup();
    useLaunchProfilesStore.setState({
      profiles: [
        createLaunchProfile({ id: "profile-codex-local", name: "Codex Local", targetRuntime: "local" }),
        createLaunchProfile({ id: "profile-codex-wsl", name: "Codex WSL", targetRuntime: "wsl" }),
      ],
      loading: false,
    });
    const { onOpenTerminal } = renderWorkspaceItem("wsl");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    await user.hover(
      await screen.findByRole("menuitem", { name: /更多启动方式|More launch options/ }),
    );
    // jsdom 下三层嵌套子菜单 hover 不触发展开，用 Radix 键盘导航展开
    const codexWslTrigger = await screen.findByRole("menuitem", { name: /Codex CLI.*WSL/ });
    codexWslTrigger.focus();
    fireEvent.keyDown(codexWslTrigger, { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Codex WSL/ }));

    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({
      cliTool: "codex",
      launchProfileId: "profile-codex-wsl",
      wsl: {
        remotePath: "/mnt/d/workspace-alpha",
      },
    }));
  });

  it("shows the hooks submenu inside settings", async () => {
    const user = userEvent.setup();
    renderWorkspaceItem("local");
    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    await user.hover(await screen.findByRole("menuitem", { name: /设置|Settings/ }));
    expect(await screen.findByRole("menuitem", { name: "Hooks" })).toBeVisible();
  });
});
