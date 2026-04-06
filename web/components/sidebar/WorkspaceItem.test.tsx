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

  it("shows the default WSL toggle and switches to wsl", async () => {
    const user = userEvent.setup();
    const { onSetDefaultEnvironment, ws } = renderWorkspaceItem("local");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));

    const item = await screen.findByRole("menuitemcheckbox", { name: "默认wsl打开" });
    expect(item).toBeVisible();

    await user.click(item);

    expect(onSetDefaultEnvironment).toHaveBeenCalledWith(ws, "wsl");
  });

  it("switches the default WSL toggle back to local", async () => {
    const user = userEvent.setup();
    const { onSetDefaultEnvironment, ws } = renderWorkspaceItem("wsl");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));

    const item = await screen.findByRole("menuitemcheckbox", { name: "默认wsl打开" });
    await user.click(item);

    expect(onSetDefaultEnvironment).toHaveBeenCalledWith(ws, "local");
  });

  it("hides the default WSL toggle on non-Windows platforms", async () => {
    Object.defineProperty(window.navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });

    renderWorkspaceItem("local");
    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));

    await waitFor(() => {
      expect(screen.queryByRole("menuitemcheckbox", { name: "默认wsl打开" })).not.toBeInTheDocument();
    });
  });

  it("opens Codex locally when the workspace default environment is local", async () => {
    const user = userEvent.setup();
    const { onOpenTerminal } = renderWorkspaceItem("local");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    await user.click(await screen.findByRole("menuitem", { name: "Codex" }));

    const call = onOpenTerminal.mock.calls[0]?.[0];
    expect(call).toEqual(expect.objectContaining({
      path: "D:/workspace-alpha",
      cliTool: "codex",
    }));
    expect(call?.wsl).toBeUndefined();
    expect(call?.providerId).toBeUndefined();
  });

  it("opens Codex through WSL when the workspace default environment is wsl", async () => {
    const user = userEvent.setup();
    const { onOpenTerminal } = renderWorkspaceItem("wsl");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    await user.click(await screen.findByRole("menuitem", { name: "Codex" }));

    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({
      path: "D:/workspace-alpha",
      cliTool: "codex",
      wsl: {
        remotePath: "/mnt/d/workspace-alpha",
      },
    }));
  });

  it("shows Claude as a dedicated launch entry", async () => {
    renderWorkspaceItem("local");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));

    expect(await screen.findByRole("menuitem", { name: "Claude" })).toBeVisible();
  });

  it("hides the workspace provider badge when default environment is wsl", () => {
    renderWorkspaceItem("wsl");

    expect(screen.queryByText("Codex Provider")).not.toBeInTheDocument();
  });

  it("still shows Claude as a launch entry when default environment is wsl", async () => {
    renderWorkspaceItem("wsl");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));
    expect(await screen.findByRole("menuitem", { name: "Claude" })).toBeVisible();
  });
});
