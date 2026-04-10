import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProvidersStore } from "@/stores";
import { createTestProvider, createTestWorkspace, resetTestDataCounter } from "@/test/utils/testData";
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
  hooksService: {
    getStatus: vi.fn(async () => []),
    enableHook: vi.fn(async () => undefined),
    disableHook: vi.fn(async () => undefined),
  },
}));

vi.mock("./AddSshProjectDialog", () => ({
  default: () => null,
}));

function renderWorkspaceItem(defaultEnvironment: "local" | "wsl" = "local") {
  const onSetDefaultEnvironment = vi.fn();
  const onOpenTerminal = vi.fn();
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
        expanded={false}
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
        onSetDefaultEnvironment={onSetDefaultEnvironment}
        onOpenInFileBrowser={vi.fn()}
      >
        <div>children</div>
      </WorkspaceItem>
    </TooltipProvider>,
  );

  return { onOpenTerminal, onSetDefaultEnvironment, ws };
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
    Object.defineProperty(window.navigator, "platform", {
      value: "Win32",
      configurable: true,
    });
  });

  it("shows the default WSL toggle inside settings", async () => {
    const user = userEvent.setup();
    renderWorkspaceItem("local");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));

    await user.hover(await screen.findByRole("menuitem", { name: /设置|Settings/ }));
    const item = await screen.findByRole("menuitemcheckbox", { name: /默认在 WSL 打开|Default Open in WSL/ });
    expect(item).toBeVisible();
    expect(item).toHaveAttribute("data-state", "unchecked");
  });

  it("marks the default WSL toggle as checked when the workspace default environment is wsl", async () => {
    const user = userEvent.setup();
    renderWorkspaceItem("wsl");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));

    await user.hover(await screen.findByRole("menuitem", { name: /设置|Settings/ }));
    const item = await screen.findByRole("menuitemcheckbox", { name: /默认在 WSL 打开|Default Open in WSL/ });
    expect(item).toHaveAttribute("data-state", "checked");
  });

  it("hides the default WSL toggle on non-Windows platforms", async () => {
    Object.defineProperty(window.navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });

    renderWorkspaceItem("local");
    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));

    await waitFor(() => {
      expect(screen.queryByRole("menuitemcheckbox", { name: /默认在 WSL 打开|Default Open in WSL/ })).not.toBeInTheDocument();
    });
  });

  it("shows CLI entries directly in the menu", async () => {
    renderWorkspaceItem("local");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));

    expect(await screen.findByRole("menuitem", { name: "Claude Code" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Codex CLI" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Gemini CLI" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Kimi CLI" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "GLM CLI" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "OpenCode" })).toBeVisible();
    expect(screen.queryByText("Claude Provider")).not.toBeInTheDocument();
  });

  it("opens Codex locally even when the workspace default environment is wsl", async () => {
    const user = userEvent.setup();
    const { onOpenTerminal } = renderWorkspaceItem("wsl");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    await user.click(await screen.findByRole("menuitem", { name: "Codex CLI" }));

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
    await user.click(await screen.findByRole("menuitem", { name: "打开终端" }));

    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({
      path: "D:/workspace-alpha",
      wsl: {
        remotePath: "/mnt/d/workspace-alpha",
      },
    }));
  });
});
