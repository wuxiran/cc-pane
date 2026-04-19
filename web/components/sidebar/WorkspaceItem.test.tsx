import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProvidersStore, useSettingsStore } from "@/stores";
import { createTestProvider, createTestSettings, createTestWorkspace, resetTestDataCounter } from "@/test/utils/testData";
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
) {
  const onOpenTerminal = vi.fn();
  const onOpenEnvironment = vi.fn();
  const ws = createTestWorkspace({
    name: "workspace-alpha",
    path: "D:/workspace-alpha",
    defaultEnvironment,
    providerId: "provider-codex",
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
    Object.defineProperty(window.navigator, "platform", {
      value: "Win32",
      configurable: true,
    });
  });

  it("shows the workspace environment entry inside settings", async () => {
    const user = userEvent.setup();
    renderWorkspaceItem("local");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));

    await user.hover(await screen.findByRole("menuitem", { name: /设置|Settings/ }));
    expect(await screen.findByRole("menuitem", { name: /运行环境/i })).toBeVisible();
  });

  it("opens the workspace environment sheet from settings", async () => {
    const user = userEvent.setup();
    const { onOpenEnvironment, ws } = renderWorkspaceItem("local");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    await user.hover(await screen.findByRole("menuitem", { name: /设置|Settings/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /运行环境/i }));

    expect(onOpenEnvironment).toHaveBeenCalledWith(ws);
  });

  it("shows CLI entries directly in the menu", async () => {
    renderWorkspaceItem("local");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));

    expect((await screen.findAllByRole("menuitem", { name: "Claude Code" })).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("menuitem", { name: "Codex CLI" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("menuitem", { name: "Gemini CLI" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("menuitem", { name: "Kimi CLI" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("menuitem", { name: "GLM CLI" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("menuitem", { name: "OpenCode" }).length).toBeGreaterThan(0);
    expect(screen.queryByText("Claude Provider")).not.toBeInTheDocument();
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
    await user.hover(await screen.findByRole("menuitem", { name: /常用|Favorites/i }));
    await user.click((await screen.findAllByRole("menuitem", { name: "Codex CLI" }))[0]);

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
    await userEvent.setup().hover(await screen.findByRole("menuitem", { name: /常用|Favorites/i }));

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
    expect(screen.queryByRole("menuitem", { name: "打开终端" })).not.toBeInTheDocument();
  });

  it("supports terminal WSL as a workspace favorite launch action in the context menu", async () => {
    const user = userEvent.setup();
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
    await user.hover(await screen.findByRole("menuitem", { name: /常用|Favorites/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^打开终端（WSL）$|^Open Terminal \(WSL\)$/i }));

    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({
      path: "D:/workspace-alpha",
      wsl: {
        remotePath: "/mnt/d/workspace-alpha",
      },
    }));
  });

  it("opens Codex locally even when the workspace default environment is wsl", async () => {
    const user = userEvent.setup();
    const { onOpenTerminal } = renderWorkspaceItem("wsl");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    await user.click((await screen.findAllByRole("menuitem", { name: "Codex CLI" }))[0]);

    const call = onOpenTerminal.mock.calls[0]?.[0];
    expect(call).toEqual(expect.objectContaining({
      path: "D:/workspace-alpha",
      cliTool: "codex",
    }));
    expect(call?.wsl).toBeUndefined();
    expect(call?.providerId).toBeUndefined();
  });

  it("shows explicit WSL CLI entries when the workspace default environment is wsl", async () => {
    renderWorkspaceItem("wsl");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));

    expect(await screen.findByRole("menuitem", { name: /Codex CLI.*WSL/ })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: /Claude Code.*WSL/ })).toBeVisible();
  });

  it("opens Codex through WSL only when choosing the explicit WSL entry", async () => {
    const user = userEvent.setup();
    const { onOpenTerminal } = renderWorkspaceItem("wsl");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    await user.click(await screen.findByRole("menuitem", { name: /Codex CLI.*WSL/ }));

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

  it("shows the hooks submenu inside settings", async () => {
    const user = userEvent.setup();
    renderWorkspaceItem("local");
    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    await user.hover(await screen.findByRole("menuitem", { name: /设置|Settings/ }));
    expect(await screen.findByRole("menuitem", { name: "Hooks" })).toBeVisible();
  });
});
