import "@/i18n";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSshMachineDialogStore, useSshMachinesStore } from "@/stores";
import type { SshMachine } from "@/types";
import type { DeviceSnapshot, DeviceSummary } from "@/types/device";

vi.mock("@/services/runtime", () => ({
  isTauriRuntime: vi.fn(() => true),
  isWebRuntime: vi.fn(() => false),
  invokeIfTauri: vi.fn(async () => undefined),
  listenIfTauri: vi.fn(async () => () => {}),
  listenWebviewIfTauri: vi.fn(async () => () => {}),
  getCurrentWindowIfTauri: vi.fn(() => null),
  logErrorSafe: vi.fn(),
  logInfoSafe: vi.fn(),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.12.21") }));
vi.mock("@/services/nativeDialog", () => ({ nativeConfirm: vi.fn(async () => true) }));
vi.mock("@/components/ui/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/services/sshMachineService", () => ({
  checkSshConnectivity: vi.fn(async () => ({ reachable: true, message: "ok", latencyMs: 5 })),
}));
vi.mock("@/components/sidebar/SshMachineDialog", () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="ssh-machine-dialog" /> : null),
}));
vi.mock("@/utils", async () => ({
  ...await vi.importActual<typeof import("@/utils")>("@/utils"),
  waitForTauri: vi.fn(async () => true),
}));
vi.mock("./openRemoteSession", () => ({
  openRemoteSession: vi.fn(async () => "tab-1"),
  startRemoteSession: vi.fn(async () => "tab-2"),
}));
vi.mock("@/services/deviceService", () => ({
  listDevices: vi.fn(),
  getDeviceSnapshot: vi.fn(),
  deployDevice: vi.fn(),
  removeDevice: vi.fn(async () => undefined),
  addDevice: vi.fn(),
  pairDevice: vi.fn(),
  setDeviceToken: vi.fn(async () => undefined),
  onDeployProgress: vi.fn(async () => () => {}),
}));

import * as deviceService from "@/services/deviceService";
import { checkSshConnectivity } from "@/services/sshMachineService";
import { useDevicesStore } from "@/stores/useDevicesStore";
import { openRemoteSession } from "./openRemoteSession";
import DevicesView from "./DevicesView";

const sshDevice: DeviceSummary = {
  id: "d1",
  name: "gpu-box",
  connection: { kind: "ssh", machineId: "m1", remotePort: 18765 },
  createdAt: "",
  hasToken: true,
  targetLabel: "dev@gpu-box",
};

const online: DeviceSnapshot = {
  deviceId: "d1",
  online: true,
  errorKind: null,
  error: null,
  info: {
    hostname: "gpu-box",
    os: "linux",
    osVersion: "Debian 12",
    arch: "x86_64",
    appVersion: "0.12.21",
    uptimeSecs: 10,
    homeDir: "/home/dev",
    defaultCwd: "/home/dev",
    headless: true,
  },
  environment: {
    node: { installed: true, version: "v20" },
    git: { installed: true, version: "2" },
    cliTools: [
      { id: "claude", installed: true, version: "2.1.3 (Claude Code)" },
      { id: "codex", installed: false, version: null },
    ],
  },
  workspaces: [{ id: "w1", name: "prod", path: "/srv", projects: [{ id: "p1", path: "/srv/api" }] }],
  sessions: [{ sessionId: "s1", status: "idle", lastOutputAt: 5 }],
  launches: [{
    ptySessionId: "s1", projectName: "api", projectPath: "/srv/api", cliTool: "claude",
    launchedAt: "", workspaceName: "prod", lastPrompt: null,
  }],
};

const gpuBox: SshMachine = {
  id: "m1",
  name: "gpu-box",
  host: "gpu-box",
  port: 22,
  user: "dev",
  authMethod: "key",
  tags: [],
  createdAt: "",
  updatedAt: "",
};

const plainHost: SshMachine = { ...gpuBox, id: "m2", name: "bare-host", host: "bare-host" };

const directDevice: DeviceSummary = {
  id: "d2",
  name: "studio-mac",
  connection: { kind: "direct", baseUrl: "http://studio.ts.net:8080" },
  createdAt: "",
  hasToken: true,
  targetLabel: "http://studio.ts.net:8080",
};

function resetStore(machines: SshMachine[] = []) {
  useDevicesStore.setState({ devices: [], loaded: false, snapshots: {}, refreshing: {}, deploying: {} });
  useSshMachinesStore.setState({ machines, load: vi.fn(async () => undefined) as never });
  useSshMachineDialogStore.setState({ addDialogOpen: false });
}

function renderView() {
  return render(
    <TooltipProvider>
      <DevicesView onOpenTerminal={vi.fn()} />
    </TooltipProvider>,
  );
}

describe("DevicesView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore([gpuBox]);
    vi.mocked(checkSshConnectivity).mockResolvedValue({ reachable: true, message: "ok", latencyMs: 5 });
  });

  it("shows the merged empty state when there are no SSH hosts and no devices", async () => {
    resetStore([]);
    vi.mocked(deviceService.listDevices).mockResolvedValue([]);
    renderView();
    expect(await screen.findByText(/还没有设备|No devices yet/)).toBeInTheDocument();
    expect(screen.getByTestId("machines-empty")).toBeInTheDocument();
  });

  it("nests an SSH host's CC-Panes under that host's entry, and opens a remote session", async () => {
    resetStore([gpuBox]);
    vi.mocked(deviceService.listDevices).mockResolvedValue([sshDevice]);
    vi.mocked(deviceService.getDeviceSnapshot).mockResolvedValue(online);
    const user = userEvent.setup();
    renderView();

    expect(await screen.findByText("gpu-box")).toBeInTheDocument();
    const entry = screen.getByTestId("machine-entry-m1");
    await waitFor(() => expect(entry).toContainElement(screen.getByTestId("device-card-d1")));
    // 同一条目上既能开 SSH 终端，也能进它的 CC-Panes
    expect(screen.getByRole("button", { name: /连接到 gpu-box|Connect to gpu-box/ })).toBeInTheDocument();
    expect(screen.getByTestId("device-card-d1")).toHaveTextContent("CC-Panes");
    await waitFor(() => expect(screen.getByTestId("device-cli-tools")).toHaveTextContent("claude 2.1.3"));
    expect(screen.getByTestId("device-cli-tools")).toHaveTextContent("codex");
    expect(screen.getByText("prod")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /api\s*claude\s*idle/ }));
    expect(openRemoteSession).toHaveBeenCalledWith(sshDevice, "s1", expect.objectContaining({
      projectPath: "/srv/api",
      cliTool: "claude",
    }));
  });

  it("offers deploy when the server is not running and reports the result", async () => {
    vi.mocked(deviceService.listDevices).mockResolvedValue([sshDevice]);
    vi.mocked(deviceService.getDeviceSnapshot).mockResolvedValue({
      ...online, online: false, errorKind: "unreachable", error: "refused",
      info: null, environment: null, workspaces: null, sessions: null, launches: null,
    });
    vi.mocked(deviceService.deployDevice).mockResolvedValue({
      platform: { os: "linux", arch: "x86_64", user: "dev", installedVersion: null },
      previousVersion: null, version: "0.12.21", manager: "systemd", warnings: ["linger off"],
    });
    renderView();

    const deploy = await screen.findByRole("button", { name: /^部署$|^Deploy$/ });
    await act(async () => {
      fireEvent.click(deploy);
    });
    expect(deviceService.deployDevice).toHaveBeenCalledWith("d1");
  });

  it("lists direct devices and SSH devices whose host was removed under Other computers", async () => {
    resetStore([plainHost]);
    vi.mocked(deviceService.listDevices).mockResolvedValue([sshDevice, directDevice]);
    vi.mocked(deviceService.getDeviceSnapshot).mockResolvedValue(online);
    renderView();

    const section = await screen.findByRole("region", { name: /其他电脑|Other computers/ });
    await waitFor(() => expect(section).toContainElement(screen.getByTestId("device-card-d2")));
    expect(section).toContainElement(screen.getByTestId("device-card-d1"));
    // 纯 SSH 主机（未部署 CC-Panes）也在同一个视图里
    expect(screen.getByTestId("machine-entry-m2")).not.toContainElement(screen.queryByTestId("device-card-d1"));
  });

  async function openMachineMenu(machineId: string) {
    const user = userEvent.setup();
    const entry = await screen.findByTestId(`machine-entry-${machineId}`);
    await user.click(within(entry).getByRole("button", { name: /更多操作|More actions/ }));
    await screen.findAllByRole("menuitem");
    return user;
  }

  it("auto-checks connectivity for every machine when the view mounts", async () => {
    resetStore([gpuBox, plainHost]);
    vi.mocked(deviceService.listDevices).mockResolvedValue([]);
    renderView();
    await waitFor(() => expect(checkSshConnectivity).toHaveBeenCalledTimes(2));
    expect(checkSshConnectivity).toHaveBeenCalledWith("m1");
    expect(checkSshConnectivity).toHaveBeenCalledWith("m2");
  });

  it("offers Deploy CC-Panes on a bare Linux host and opens the add dialog preset to it", async () => {
    resetStore([plainHost]);
    vi.mocked(deviceService.listDevices).mockResolvedValue([]);
    vi.mocked(checkSshConnectivity).mockResolvedValue({ reachable: true, message: "ok", latencyMs: 5, os: "linux" });
    renderView();

    expect(await screen.findByTestId("machine-os-m2")).toHaveTextContent("Linux");
    const user = await openMachineMenu("m2");
    await user.click(screen.getByRole("menuitem", { name: /部署 CC-Panes|Deploy CC-Panes/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(/添加设备|Add device/);
    expect(screen.getByTestId("device-machine-select")).toHaveTextContent("bare-host");
  });

  it("hides Deploy CC-Panes for Windows hosts", async () => {
    resetStore([plainHost]);
    vi.mocked(deviceService.listDevices).mockResolvedValue([]);
    vi.mocked(checkSshConnectivity).mockResolvedValue({ reachable: true, message: "ok", latencyMs: 5, os: "windows" });
    renderView();

    expect(await screen.findByTestId("machine-os-m2")).toHaveTextContent("Windows");
    await openMachineMenu("m2");
    expect(screen.queryByRole("menuitem", { name: /部署 CC-Panes|Deploy CC-Panes/ })).toBeNull();
    expect(screen.queryByTestId("machine-connect-ccpanes")).toBeNull();
  });

  it("offers connecting to a detected CC-Panes and prefills its address in pairing mode", async () => {
    resetStore([plainHost]);
    vi.mocked(deviceService.listDevices).mockResolvedValue([]);
    vi.mocked(checkSshConnectivity).mockResolvedValue({
      reachable: true, message: "ok", latencyMs: 5, os: "linux",
      ccPanes: { baseUrl: "http://192.168.2.182:18081", port: 18081, pairingSupported: true },
    });
    renderView();

    expect(await screen.findByTestId("machine-ccpanes-badge-m2")).toHaveTextContent(/CC-Panes 运行中|CC-Panes running/);
    const user = await openMachineMenu("m2");
    expect(screen.queryByRole("menuitem", { name: /部署 CC-Panes|Deploy CC-Panes/ })).toBeNull();
    await user.click(screen.getByTestId("machine-connect-ccpanes"));
    expect(await screen.findByTestId("device-pairing-code")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/tailnet/)).toHaveValue("http://192.168.2.182:18081");
  });

  it("disables the connect item with an upgrade hint when the remote cannot pair", async () => {
    resetStore([plainHost]);
    vi.mocked(deviceService.listDevices).mockResolvedValue([]);
    vi.mocked(checkSshConnectivity).mockResolvedValue({
      reachable: true, message: "ok", latencyMs: 5, os: "linux",
      ccPanes: { baseUrl: "http://192.168.2.182:18081", port: 18081, pairingSupported: false },
    });
    renderView();

    await screen.findByTestId("machine-ccpanes-badge-m2");
    await openMachineMenu("m2");
    const item = screen.getByTestId("machine-connect-ccpanes");
    expect(item).toHaveAttribute("data-disabled");
    expect(item).toHaveTextContent(/0\.12\.22/);
  });

  it("has a single add entry that asks for the type first", async () => {
    vi.mocked(deviceService.listDevices).mockResolvedValue([]);
    const user = userEvent.setup();
    renderView();

    await user.click(await screen.findByRole("button", { name: /^添加设备$|^Add device$/ }));
    expect(await screen.findByTestId("machines-add-ssh-host")).toBeInTheDocument();
    expect(screen.getByTestId("machines-add-ssh-device")).toBeInTheDocument();
    await user.click(screen.getByTestId("machines-add-direct"));
    expect(await screen.findByTestId("device-pairing-code")).toBeInTheDocument();
  });

  it("routes the SSH host add option to the SSH machine dialog", async () => {
    vi.mocked(deviceService.listDevices).mockResolvedValue([]);
    const user = userEvent.setup();
    renderView();

    await user.click(await screen.findByRole("button", { name: /^添加设备$|^Add device$/ }));
    await user.click(await screen.findByTestId("machines-add-ssh-host"));
    expect(await screen.findByTestId("ssh-machine-dialog")).toBeInTheDocument();
  });
});
