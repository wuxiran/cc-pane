import "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDialogStore, useEnvironmentStore, useSshMachinesStore, useWorkspacesStore } from "@/stores";
import * as workspaceService from "@/services/workspaceService";
import { createTestWorkspace, resetTestDataCounter } from "@/test/utils/testData";
import WorkspaceEnvironmentPanel from "./WorkspaceEnvironmentPanel";

vi.mock("@/services/workspaceService", () => ({
  saveWorkspace: vi.fn(),
}));

vi.mock("@/services/sshMachineService", () => ({
  listSshMachines: vi.fn(async () => []),
  discoverWslDistros: vi.fn(async () => []),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const baseWslState = {
  status: "done" as const,
  available: true,
  distros: [
    {
      name: "Ubuntu",
      state: "running" as const,
      wslVersion: 2,
      isDefault: true,
      defaultUser: "dev",
      alreadyImported: false,
    },
  ],
  error: null,
  detectedAt: 1,
};

function renderPanel() {
  return render(<WorkspaceEnvironmentPanel />);
}

describe("WorkspaceEnvironmentPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTestDataCounter();
    Object.defineProperty(window.navigator, "platform", {
      value: "Win32",
      configurable: true,
    });

    useWorkspacesStore.setState({
      workspaces: [],
      expandedWorkspaceId: null,
      expandedProjectId: null,
      loading: false,
    });
    useDialogStore.setState({
      workspaceEnvironmentOpen: false,
      workspaceEnvironmentWorkspaceId: "",
    });
    useSshMachinesStore.setState({ machines: [] });
    useEnvironmentStore.setState({
      platform: "windows",
      wsl: baseWslState,
      _initialized: true,
    });
  });

  it("saves the full workspace draft through the store", async () => {
    const user = userEvent.setup();
    const workspace = createTestWorkspace({
      id: "ws-1",
      name: "workspace-alpha",
      path: "D:/workspace-alpha",
      defaultEnvironment: "local",
      wsl: {
        distro: "Ubuntu",
        remotePath: "/mnt/d/workspace-alpha",
      },
      sshLaunch: {
        machineId: "machine-1",
        remotePath: "/home/dev/workspace-alpha",
      },
    });

    useWorkspacesStore.setState({ workspaces: [workspace] });
    useSshMachinesStore.setState({
      machines: [
        {
          id: "machine-1",
          name: "Devbox",
          host: "example.com",
          port: 22,
          user: "dev",
          authMethod: "key",
          defaultPath: "/home/dev/workspace-alpha",
          tags: [],
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ],
    });
    useDialogStore.setState({
      workspaceEnvironmentOpen: true,
      workspaceEnvironmentWorkspaceId: workspace.id,
    });
    vi.mocked(workspaceService.saveWorkspace).mockResolvedValue();

    renderPanel();

    const localPathInput = await screen.findByDisplayValue("D:/workspace-alpha");
    await user.clear(localPathInput);
    await user.type(localPathInput, "D:/workspace-alpha-next");

    await user.click(screen.getByRole("button", { name: /保存更改|Save Changes/i }));

    expect(workspaceService.saveWorkspace).toHaveBeenCalledWith("workspace-alpha", {
      ...workspace,
      path: "D:/workspace-alpha-next",
      defaultEnvironment: "local",
      wsl: {
        distro: "Ubuntu",
        remotePath: "/mnt/d/workspace-alpha",
      },
      sshLaunch: {
        machineId: "machine-1",
        remotePath: "/home/dev/workspace-alpha",
      },
    });
  });

  it("shows a discard confirmation when closing with unsaved changes", async () => {
    const user = userEvent.setup();
    const workspace = createTestWorkspace({
      id: "ws-1",
      name: "workspace-alpha",
      path: "D:/workspace-alpha",
    });

    useWorkspacesStore.setState({ workspaces: [workspace] });
    useDialogStore.setState({
      workspaceEnvironmentOpen: true,
      workspaceEnvironmentWorkspaceId: workspace.id,
    });

    renderPanel();

    const localPathInput = await screen.findByDisplayValue("D:/workspace-alpha");
    await user.clear(localPathInput);
    await user.type(localPathInput, "D:/workspace-alpha-next");
    const closeButtons = screen.getAllByRole("button", { name: /关闭|Close/i });
    await user.click(closeButtons[0]);

    expect(await screen.findByText(/放弃未保存的更改|Discard unsaved changes/i)).toBeVisible();
    expect(useDialogStore.getState().workspaceEnvironmentOpen).toBe(true);
  });

  it("disables save when the default environment is invalid", async () => {
    const workspace = createTestWorkspace({
      id: "ws-1",
      name: "workspace-alpha",
      defaultEnvironment: "ssh",
      path: "D:/workspace-alpha",
    });

    useWorkspacesStore.setState({ workspaces: [workspace] });
    useDialogStore.setState({
      workspaceEnvironmentOpen: true,
      workspaceEnvironmentWorkspaceId: workspace.id,
    });

    renderPanel();

    const issueTexts = await screen.findAllByText(/SSH 环境需要先选择机器|SSH launch requires a selected machine/i);
    expect(issueTexts.length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /保存更改|Save Changes/i })).toBeDisabled();
  });
});
