import i18n from "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  useRightDockStore,
  useSshMachinePreferencesStore,
  useSshMachineDialogStore,
  useSshMachinesStore,
  useSshRemoteFilesStore,
} from "@/stores";
import type { SshMachine } from "@/types";
import SshMachinesView from "./SshMachinesView";

const sshFileMocks = vi.hoisted(() => ({
  configurePassword: vi.fn(async () => undefined),
}));

vi.mock("@/services", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/services")>(),
  sshFileService: sshFileMocks,
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/services/sshMachineService", () => ({
  checkSshConnectivity: vi.fn(async () => ({
    reachable: true,
    message: "reachable",
    latencyMs: 8,
  })),
}));

// Keep the child dialogs inert so we can test the view in isolation.
vi.mock("./SshMachineDialog", () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="ssh-machine-dialog" /> : null,
}));
vi.mock("./WslDiscoverDialog", () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="wsl-dialog" /> : null,
}));

// waitForTauri resolves true so the view calls load() on mount.
vi.mock("@/utils", async () => {
  const actual = await vi.importActual<typeof import("@/utils")>("@/utils");
  return {
    ...actual,
    waitForTauri: vi.fn(async () => true),
  };
});

import { toast } from "sonner";
import { checkSshConnectivity } from "@/services/sshMachineService";

const mockCheck = vi.mocked(checkSshConnectivity);

function createMachine(overrides: Partial<SshMachine> = {}): SshMachine {
  return {
    id: "m-1",
    name: "devbox",
    host: "devbox.local",
    port: 2222,
    user: "dev",
    authMethod: "key",
    identityFile: "~/.ssh/id_devbox",
    description: "prod box",
    defaultPath: "/srv/app",
    tags: ["prod"],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function renderView(machines: SshMachine[] = []) {
  const onOpenTerminal = vi.fn();
  const loadMock = vi.fn(async () => undefined);
  const removeMock = vi.fn(async () => undefined);
  useSshMachinesStore.setState({
    machines,
    load: loadMock as never,
    remove: removeMock as never,
  });
  render(
    <TooltipProvider>
      <SshMachinesView onOpenTerminal={onOpenTerminal} />
    </TooltipProvider>,
  );
  return { onOpenTerminal, loadMock, removeMock };
}

describe("SshMachinesView", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    await i18n.changeLanguage("zh-CN");
    useSshMachinesStore.setState({ machines: [] });
    useSshMachineDialogStore.setState({ addDialogOpen: false });
    useSshMachinePreferencesStore.setState({
      favoriteMachineIds: [],
      selectedMachineId: null,
    });
    useSshRemoteFilesStore.setState({ sessionPasswordMachineIds: [] });
    useSshRemoteFilesStore.getState().clear();
    useRightDockStore.setState({ visible: false, activeView: "git" });
    mockCheck.mockResolvedValue({
      reachable: true,
      message: "reachable",
      latencyMs: 8,
    });
    Object.defineProperty(window.navigator, "platform", {
      value: "Win32",
      configurable: true,
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => undefined) },
      configurable: true,
    });
  });

  it("loads machines on mount", async () => {
    const { loadMock } = renderView([]);
    await waitFor(() => expect(loadMock).toHaveBeenCalled());
  });

  it("opens the add-machine dialog when requested externally", async () => {
    renderView([]);

    act(() => {
      useSshMachineDialogStore.getState().openAddDialog();
    });

    expect(await screen.findByTestId("ssh-machine-dialog")).toBeVisible();
  });

  it("shows the empty state when there are no machines", () => {
    renderView([]);
    expect(screen.getByText(/No SSH machines|没有|无/i)).toBeVisible();
  });

  it("renders a machine row with its connection and tags", () => {
    renderView([createMachine()]);
    expect(screen.getByText("devbox")).toBeVisible();
    expect(screen.getByText("dev@devbox.local:2222")).toBeVisible();
    expect(screen.getAllByText("prod")[0]).toBeVisible();
    expect(screen.getByText("prod box")).toBeVisible();
  });

  it("switches SSH machine actions between Chinese and English", async () => {
    renderView([createMachine()]);

    expect(screen.getByRole("button", { name: "检测全部连通性" })).toBeVisible();
    expect(screen.getByRole("button", { name: "更多操作" })).toBeVisible();

    fireEvent.contextMenu(screen.getByText("devbox"));
    expect(await screen.findByRole("menuitem", { name: "连接" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "检测连通性" })).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });

    await act(async () => {
      await i18n.changeLanguage("en");
    });
    expect(screen.getByRole("button", { name: "Check All Connectivity" })).toBeVisible();
    expect(screen.getByRole("button", { name: "More actions" })).toBeVisible();
  });

  it("opens the selected machine files in the right dock", async () => {
    const user = userEvent.setup();
    renderView([createMachine()]);

    await user.click(screen.getByRole("button", {
      name: /Open remote files for devbox|打开 devbox 的远程文件/,
    }));

    expect(useSshRemoteFilesStore.getState()).toMatchObject({
      machineId: "m-1",
      currentPath: "/srv/app",
    });
    expect(useRightDockStore.getState()).toMatchObject({
      visible: true,
      activeView: "sshFiles",
    });
  });

  it("shows machine metrics and groups untagged machines", () => {
    renderView([createMachine({ tags: [] })]);

    expect(screen.queryByRole("textbox", { name: /Search machines|搜索机器/ })).toBeNull();
    expect(screen.getAllByText(/Machines|机器/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Favorites|收藏/).length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: /Ungrouped|未分组/ })).toBeVisible();
    expect(screen.getByText(/Key|密钥/)).toBeVisible();
    expect(screen.getByText(/Not checked|未检测/)).toBeVisible();
  });

  it("opens the add dialog from the header button", async () => {
    const user = userEvent.setup();
    renderView([]);

    // header add button is icon-only (Plus icon)
    const plusBtn = document
      .querySelector("svg.lucide-plus")
      ?.closest("button");
    expect(plusBtn).toBeTruthy();
    await user.click(plusBtn as HTMLButtonElement);

    expect(screen.getByTestId("ssh-machine-dialog")).toBeInTheDocument();
  });

  it("opens the add dialog from the empty-state CTA", async () => {
    const user = userEvent.setup();
    renderView([]);

    await user.click(
      screen.getByText(/Add your first machine|添加.*第一/i),
    );

    expect(screen.getByTestId("ssh-machine-dialog")).toBeInTheDocument();
  });

  it("selects a machine on click without opening a terminal", async () => {
    const user = userEvent.setup();
    const { onOpenTerminal } = renderView([createMachine()]);

    await user.click(screen.getByText("devbox"));

    expect(useSshMachinePreferencesStore.getState().selectedMachineId).toBe("m-1");
    expect(onOpenTerminal).not.toHaveBeenCalled();
    expect(screen.getByText("devbox").closest("[aria-selected='true']")).not.toBeNull();
  });

  it("auto-selects the only machine in the list", async () => {
    renderView([createMachine()]);

    await waitFor(() => {
      expect(useSshMachinePreferencesStore.getState().selectedMachineId).toBe("m-1");
    });
  });

  it("connects on double-click", () => {
    const { onOpenTerminal } = renderView([createMachine()]);

    fireEvent.doubleClick(screen.getByText("devbox"));

    expect(onOpenTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "ssh://dev@devbox.local:2222//srv/app",
        machineName: "devbox",
        ssh: expect.objectContaining({
          host: "devbox.local",
          port: 2222,
          user: "dev",
          remotePath: "/srv/app",
          machineId: "m-1",
          authMethod: "key",
        }),
      }),
    );
  });

  it("connects from the row quick action", async () => {
    const user = userEvent.setup();
    const { onOpenTerminal } = renderView([createMachine()]);

    await user.click(
      screen.getByRole("button", { name: /Connect to devbox|连接到 devbox/ }),
    );

    expect(onOpenTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ machineName: "devbox" }),
    );
    expect(useSshRemoteFilesStore.getState()).toMatchObject({
      machineId: "m-1",
      currentPath: "/srv/app",
    });
    expect(useRightDockStore.getState()).toMatchObject({
      visible: true,
      activeView: "sshFiles",
    });
  });

  it("asks once before connecting a password machine and shares the credential", async () => {
    const user = userEvent.setup();
    const passwordMachine = createMachine({
      authMethod: "password",
      identityFile: undefined,
      hasStoredPassword: false,
    });
    const { onOpenTerminal } = renderView([passwordMachine]);

    await user.click(
      screen.getByRole("button", { name: /Connect to devbox|连接到 devbox/ }),
    );

    expect(onOpenTerminal).not.toHaveBeenCalled();
    await user.type(await screen.findByLabelText(/SSH password|SSH 密码/), "one-time-secret");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: /Connect|连接/ }));

    await waitFor(() => expect(sshFileMocks.configurePassword).toHaveBeenCalledWith(
      "m-1",
      "one-time-secret",
      false,
    ));
    expect(onOpenTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ machineName: "devbox" }),
    );
    expect(useRightDockStore.getState()).toMatchObject({
      visible: true,
      activeView: "sshFiles",
    });
  });

  it("filters machines by tags", async () => {
    const user = userEvent.setup();
    const otherMachine = createMachine({
      id: "m-2",
      name: "stagingbox",
      host: "staging.local",
      tags: ["staging"],
    });
    renderView([createMachine(), otherMachine]);

    expect(screen.getByText("stagingbox")).toBeVisible();
    expect(screen.getByText("devbox")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "staging" }));
    expect(screen.getByText("stagingbox")).toBeVisible();
    expect(screen.queryByText("devbox")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "prod" }));
    expect(screen.getByText("devbox")).toBeVisible();
    expect(screen.queryByText("stagingbox")).not.toBeInTheDocument();
  });

  it("favorites a machine and filters by favorites", async () => {
    const user = userEvent.setup();
    const otherMachine = createMachine({ id: "m-2", name: "stagingbox" });
    renderView([createMachine(), otherMachine]);

    await user.click(
      screen.getAllByRole("button", { name: /Add to Favorites|添加到收藏/ })[0],
    );
    expect(useSshMachinePreferencesStore.getState().favoriteMachineIds).toEqual([
      "m-1",
    ]);

    await user.click(screen.getByRole("button", { name: /^(Favorites|收藏)\s*1$/ }));
    expect(screen.getByText("devbox")).toBeVisible();
    expect(screen.queryByText("stagingbox")).not.toBeInTheDocument();
  });

  it("copies connection info via the context menu", async () => {
    renderView([createMachine()]);

    fireEvent.contextMenu(screen.getByText("devbox"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Copy Connection|复制/i }),
    );

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "dev@devbox.local:2222",
      ),
    );
    expect(toast.success).toHaveBeenCalled();
  });

  it("localizes clipboard failures", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
      configurable: true,
    });
    renderView([createMachine()]);

    fireEvent.contextMenu(screen.getByText("devbox"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "复制连接信息" }),
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      "复制失败: 剪贴板 API 不可用",
    ));
  });

  it("deletes a machine after confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { removeMock } = renderView([createMachine()]);

    fireEvent.contextMenu(screen.getByText("devbox"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Delete|删除/i }),
    );

    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("m-1"));
    expect(toast.success).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("does not delete when confirmation is cancelled", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { removeMock } = renderView([createMachine()]);

    fireEvent.contextMenu(screen.getByText("devbox"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Delete|删除/i }),
    );

    expect(removeMock).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("checks connectivity for a single machine from the context menu", async () => {
    renderView([createMachine()]);

    fireEvent.contextMenu(screen.getByText("devbox"));
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: /Check Connectivity|检测连通|连通性/i,
      }),
    );

    await waitFor(() => expect(mockCheck).toHaveBeenCalledWith("m-1"));
  });

  it("connects from the context menu", async () => {
    const { onOpenTerminal } = renderView([createMachine()]);

    fireEvent.contextMenu(screen.getByText("devbox"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /^Connect$|^连接$/i }),
    );

    expect(onOpenTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ machineName: "devbox" }),
    );
  });
});
