import "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { useDialogStore, useEnvironmentStore, useSshMachinesStore, useWorkspacesStore } from "@/stores";
import * as workspaceService from "@/services/workspaceService";
import { createTestWorkspace, resetTestDataCounter } from "@/test/utils/testData";
import WorkspaceEnvironmentPanel from "./WorkspaceEnvironmentPanel";

vi.mock("@/services/workspaceService", () => ({
  getWorkspace: vi.fn(),
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
    vi.mocked(workspaceService.getWorkspace).mockImplementation(async (name: string) => {
      const workspace = useWorkspacesStore.getState().workspaces.find((item) => item.name === name);
      if (!workspace) throw new Error(`Workspace not found: ${name}`);
      return workspace;
    });
    vi.mocked(workspaceService.saveWorkspace).mockResolvedValue();
  });

  it("re-fetches and saves the full workspace draft through the store", async () => {
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
    vi.mocked(workspaceService.getWorkspace).mockResolvedValue({
      ...workspace,
      providerId: "provider-latest",
    });

    renderPanel();

    const localPathInput = await screen.findByDisplayValue("D:/workspace-alpha");
    await user.clear(localPathInput);
    await user.type(localPathInput, "D:/workspace-alpha-next");

    await user.click(screen.getByRole("button", { name: /保存更改|Save Changes/i }));

    expect(workspaceService.getWorkspace).toHaveBeenCalledWith("workspace-alpha");
    expect(workspaceService.saveWorkspace).toHaveBeenCalledWith("workspace-alpha", {
      ...workspace,
      providerId: "provider-latest",
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

  it("shows CLI defaults with inherit labels", async () => {
    const workspace = createTestWorkspace({
      id: "ws-1",
      name: "workspace-alpha",
      path: "D:/workspace-alpha",
      defaultEnvironment: "local",
    });

    useWorkspacesStore.setState({ workspaces: [workspace] });
    useDialogStore.setState({
      workspaceEnvironmentOpen: true,
      workspaceEnvironmentWorkspaceId: workspace.id,
    });

    renderPanel();

    expect(await screen.findByText(/CLI 默认环境|CLI Default Environment/i)).toBeVisible();
    expect(screen.getByRole("radio", { name: /Claude Code: (继承默认|Inherit Default)/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Codex CLI: (继承默认|Inherit Default)/i })).toBeChecked();
  });

  it("saves a Claude CLI default environment", async () => {
    const user = userEvent.setup();
    const workspace = createTestWorkspace({
      id: "ws-1",
      name: "workspace-alpha",
      path: "D:/workspace-alpha",
      defaultEnvironment: "local",
    });

    useWorkspacesStore.setState({ workspaces: [workspace] });
    useDialogStore.setState({
      workspaceEnvironmentOpen: true,
      workspaceEnvironmentWorkspaceId: workspace.id,
    });

    renderPanel();

    await user.click(await screen.findByRole("radio", { name: /^Claude Code: WSL$/i }));
    await user.click(screen.getByRole("button", { name: /保存更改|Save Changes/i }));

    expect(workspaceService.saveWorkspace).toHaveBeenCalledWith("workspace-alpha", expect.objectContaining({
      cliEnvironmentDefaults: {
        claude: "wsl",
        codex: undefined,
      },
    }));
  });

  it("omits CLI defaults when both tools inherit", async () => {
    const user = userEvent.setup();
    const workspace = createTestWorkspace({
      id: "ws-1",
      name: "workspace-alpha",
      path: "D:/workspace-alpha",
      defaultEnvironment: "local",
      cliEnvironmentDefaults: {
        claude: "wsl",
      },
    });

    useWorkspacesStore.setState({ workspaces: [workspace] });
    useDialogStore.setState({
      workspaceEnvironmentOpen: true,
      workspaceEnvironmentWorkspaceId: workspace.id,
    });

    renderPanel();

    await user.click(await screen.findByRole("radio", { name: /Claude Code: (继承默认|Inherit Default)/i }));
    await user.click(screen.getByRole("button", { name: /保存更改|Save Changes/i }));

    expect(workspaceService.saveWorkspace).toHaveBeenCalledWith("workspace-alpha", expect.objectContaining({
      cliEnvironmentDefaults: undefined,
    }));
  });

  it("disables invalid concrete CLI default choices", async () => {
    const workspace = createTestWorkspace({
      id: "ws-1",
      name: "workspace-alpha",
      path: undefined,
      projects: [],
      defaultEnvironment: "local",
    });

    useWorkspacesStore.setState({ workspaces: [workspace] });
    useDialogStore.setState({
      workspaceEnvironmentOpen: true,
      workspaceEnvironmentWorkspaceId: workspace.id,
    });

    renderPanel();

    expect(await screen.findByRole("radio", { name: /^Claude Code: WSL$/i })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /^Codex CLI: WSL$/i })).toBeDisabled();
  });

  it("blocks save and shows a toast when a CLI default is not configured", async () => {
    const user = userEvent.setup();
    // 路径须匹配宿主平台:黑屏修复(docs/46)后跨平台路径会触发 platform-mismatch
    // issue 直接禁用保存按钮,本用例要测的是 CLI 默认环境校验,需给合法本机路径
    const hostPath =
      process.platform === "win32" ? "C:\\tmp\\workspace-alpha" : "/tmp/workspace-alpha";
    const workspace = createTestWorkspace({
      id: "ws-1",
      name: "workspace-alpha",
      path: hostPath,
      defaultEnvironment: "local",
      // claude 默认 ssh 且无 ssh 配置 → 任何平台都必然"未配置":
      // wsl 前提在 Windows 上会被盘符路径自动推导补全,不再产生 issue
      cliEnvironmentDefaults: {
        claude: "ssh",
      },
    });

    useWorkspacesStore.setState({ workspaces: [workspace] });
    useDialogStore.setState({
      workspaceEnvironmentOpen: true,
      workspaceEnvironmentWorkspaceId: workspace.id,
    });

    renderPanel();

    await user.click(await screen.findByRole("radio", { name: /^Codex CLI: Local$|^Codex CLI: 本机$/i }));
    await user.click(screen.getByRole("button", { name: /保存更改|Save Changes/i }));

    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/CLI 默认环境|CLI default environment/i));
    expect(workspaceService.saveWorkspace).not.toHaveBeenCalled();
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
