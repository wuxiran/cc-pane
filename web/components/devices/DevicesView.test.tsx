import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
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

function resetStore() {
  useDevicesStore.setState({ devices: [], loaded: false, snapshots: {}, refreshing: {}, deploying: {} });
}

describe("DevicesView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it("shows the empty state when there are no devices", async () => {
    vi.mocked(deviceService.listDevices).mockResolvedValue([]);
    render(<DevicesView />);
    expect(await screen.findByText(/还没有设备|No devices yet/)).toBeInTheDocument();
  });

  it("renders an online device with CLI status, sessions and workspaces, and opens a session", async () => {
    vi.mocked(deviceService.listDevices).mockResolvedValue([sshDevice]);
    vi.mocked(deviceService.getDeviceSnapshot).mockResolvedValue(online);
    const user = userEvent.setup();
    render(<DevicesView />);

    expect(await screen.findByText("gpu-box")).toBeInTheDocument();
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
    render(<DevicesView />);

    const deploy = await screen.findByRole("button", { name: /^部署$|^Deploy$/ });
    await act(async () => {
      fireEvent.click(deploy);
    });
    expect(deviceService.deployDevice).toHaveBeenCalledWith("d1");
  });
});
