import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSummary } from "@/types/device";

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
vi.mock("@/services/nativeDialog", () => ({ nativeConfirm: vi.fn(async () => true) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/services/deviceService", () => ({
  pairDevice: vi.fn(),
  addDevice: vi.fn(),
  setDeviceToken: vi.fn(async () => undefined),
  listDevices: vi.fn(async () => []),
  getDeviceSnapshot: vi.fn(),
  listDeviceAccess: vi.fn(async () => []),
  startDevicePairing: vi.fn(),
  cancelDevicePairing: vi.fn(async () => undefined),
  revokeDeviceAccess: vi.fn(async () => undefined),
}));

import * as deviceService from "@/services/deviceService";
import { useSettingsStore, useSshMachinesStore } from "@/stores";
import AddDeviceDialog from "./AddDeviceDialog";
import DeviceAccessPanel from "./DeviceAccessPanel";
import DeviceTokenDialog from "./DeviceTokenDialog";

const direct: DeviceSummary = {
  id: "d2",
  name: "studio",
  connection: { kind: "direct", baseUrl: "http://100.64.0.2:18080" },
  createdAt: "",
  hasToken: true,
  targetLabel: "http://100.64.0.2:18080",
};

describe("AddDeviceDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSshMachinesStore.setState({ machines: [], load: vi.fn(async () => {}) } as never);
  });

  it("pairs with another computer using an address and a 6-digit code", async () => {
    vi.mocked(deviceService.pairDevice).mockResolvedValue(direct);
    const onAdded = vi.fn();
    const user = userEvent.setup();
    render(<AddDeviceDialog open onOpenChange={() => {}} onAdded={onAdded} />);

    await user.click(screen.getByRole("tab", { name: /直连|Direct/ }));
    await user.type(screen.getByPlaceholderText(/tailnet/), "http://100.64.0.2:18080");
    const submit = screen.getByTestId("device-add-submit");
    await user.type(screen.getByTestId("device-pairing-code"), "12a3456");
    expect(screen.getByTestId("device-pairing-code")).toHaveValue("123456");
    await user.click(submit);

    expect(deviceService.pairDevice).toHaveBeenCalledWith("", "http://100.64.0.2:18080", "123456");
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(direct, false));
  });

  it("warns about plain HTTP on a LAN address and can fall back to a token", async () => {
    const user = userEvent.setup();
    render(<AddDeviceDialog open onOpenChange={() => {}} onAdded={() => {}} />);
    await user.click(screen.getByRole("tab", { name: /直连|Direct/ }));
    await user.type(screen.getByPlaceholderText(/tailnet/), "http://192.168.1.9:18080");
    expect(screen.getByText(/明文|plain HTTP/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /改用令牌|token instead/ }));
    expect(screen.getByPlaceholderText("ccp_dev_…")).toBeInTheDocument();
  });
});

describe("DeviceTokenDialog", () => {
  it("saves a pasted token", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<DeviceTokenDialog device={direct} onClose={onClose} />);
    await user.type(screen.getByPlaceholderText("ccp_dev_…"), "ccp_dev_abc{Enter}");
    await waitFor(() => expect(deviceService.setDeviceToken).toHaveBeenCalledWith("d2", "ccp_dev_abc"));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("DeviceAccessPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks to save first when the toggle is not saved yet", () => {
    useSettingsStore.setState({ settings: { webAccess: { allowDevices: false } } } as never);
    render(<DeviceAccessPanel allowDevices onAllowDevicesChange={() => {}} />);
    expect(screen.getByText(/保存设置后|Save settings before/)).toBeInTheDocument();
  });

  it("generates a pairing code, lists paired devices and revokes access", async () => {
    useSettingsStore.setState({ settings: { webAccess: { allowDevices: true } } } as never);
    vi.mocked(deviceService.startDevicePairing).mockResolvedValue({
      code: "654321",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      addresses: ["http://100.64.0.3:18080"],
    });
    vi.mocked(deviceService.listDeviceAccess).mockResolvedValue([
      { id: "t1", name: "laptop", hint: "ccp_dev_ab12cd", createdAt: new Date().toISOString() },
    ]);
    const user = userEvent.setup();
    render(<DeviceAccessPanel allowDevices onAllowDevicesChange={() => {}} />);

    expect(await screen.findByText("laptop")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /生成配对码|Generate pairing code/ }));
    expect(await screen.findByTestId("device-pairing-code-display")).toHaveTextContent("654321");
    expect(screen.getByText("http://100.64.0.3:18080")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^移除$|^Remove$/ }));
    await waitFor(() => expect(deviceService.revokeDeviceAccess).toHaveBeenCalledWith("t1"));
  });
});
