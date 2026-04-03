import "@/i18n";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorkspaceItem from "./WorkspaceItem";
import { createTestWorkspace, resetTestDataCounter } from "@/test/utils/testData";

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
  useCliTools: () => ({ tools: [] }),
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
  const ws = createTestWorkspace({
    name: "workspace-alpha",
    path: "D:/workspace-alpha",
    defaultEnvironment,
  });

  render(
    <WorkspaceItem
      ws={ws}
      expanded={false}
      onExpand={vi.fn()}
      onOpenTerminal={vi.fn()}
      onRename={vi.fn()}
      onDelete={vi.fn()}
      onSetAlias={vi.fn()}
      onImportProject={vi.fn()}
      onScanImport={vi.fn()}
      onGitClone={vi.fn()}
      onSetPath={vi.fn()}
      onClearPath={vi.fn()}
      onSetProvider={vi.fn()}
      onSetDefaultEnvironment={onSetDefaultEnvironment}
      onOpenInFileBrowser={vi.fn()}
    >
      <div>children</div>
    </WorkspaceItem>
  );

  return { onSetDefaultEnvironment, ws };
}

describe("WorkspaceItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTestDataCounter();
    Object.defineProperty(window.navigator, "platform", {
      value: "Win32",
      configurable: true,
    });
  });

  it("在一级右键菜单显示默认wsl打开并切换到 wsl", async () => {
    const user = userEvent.setup();
    const { onSetDefaultEnvironment, ws } = renderWorkspaceItem("local");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));

    const item = await screen.findByRole("menuitemcheckbox", { name: "默认wsl打开" });
    expect(item).toBeVisible();

    await user.click(item);

    expect(onSetDefaultEnvironment).toHaveBeenCalledWith(ws, "wsl");
  });

  it("在已启用时点击会切换回 local", async () => {
    const user = userEvent.setup();
    const { onSetDefaultEnvironment, ws } = renderWorkspaceItem("wsl");

    fireEvent.contextMenu(screen.getByRole("button", { name: /workspace-alpha/i }));

    const item = await screen.findByRole("menuitemcheckbox", { name: "默认wsl打开" });
    await user.click(item);

    expect(onSetDefaultEnvironment).toHaveBeenCalledWith(ws, "local");
  });

  it("非 Windows 平台不显示默认wsl打开", async () => {
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
});
