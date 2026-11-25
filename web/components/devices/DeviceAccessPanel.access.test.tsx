import "@/i18n";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

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
vi.mock("@/components/ui/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/services/deviceService", () => ({
  listDeviceAccess: vi.fn(async () => []),
  startDevicePairing: vi.fn(),
  cancelDevicePairing: vi.fn(async () => undefined),
  revokeDeviceAccess: vi.fn(async () => undefined),
}));
vi.mock("@/services/accessService", () => ({
  listWebSessions: vi.fn(async () => ({ webRunning: true, sessions: [] })),
  revokeWebSession: vi.fn(async () => undefined),
  revokeOtherAccess: vi.fn(async () => ({ deviceTokens: 0, webSessions: 0 })),
}));

import * as deviceService from "@/services/deviceService";
import * as accessService from "@/services/accessService";
import { nativeConfirm } from "@/services/nativeDialog";
import { useSettingsStore } from "@/stores";
import DeviceAccessPanel from "./DeviceAccessPanel";

const tr = (key: string, options?: Record<string, unknown>) => String(i18n.t(key as never, options as never));
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ settings: { webAccess: { allowDevices: true } } } as never);
  vi.mocked(deviceService.listDeviceAccess).mockResolvedValue([
    {
      id: "online", name: "laptop", hint: "ccp_dev_aaaaaa", createdAt: minutesAgo(600),
      expiresAt: new Date(Date.now() + 86_400_000 * 30).toISOString(), expired: false,
      lastSeenAt: minutesAgo(1), lastIp: "192.168.1.5",
    },
    {
      id: "idle", name: "desk", hint: "ccp_dev_bbbbbb", createdAt: minutesAgo(600),
      expiresAt: null, expired: false, lastSeenAt: minutesAgo(12), lastIp: "100.64.0.2",
    },
    {
      id: "old", name: "server", hint: "ccp_dev_cccccc", createdAt: minutesAgo(60_000),
      expiresAt: minutesAgo(5), expired: true, lastSeenAt: null, lastIp: null,
    },
  ]);
  vi.mocked(accessService.listWebSessions).mockResolvedValue({
    webRunning: true,
    sessions: [
      {
        id: "abcdef0123456789", createdAt: minutesAgo(30), lastActivityAt: minutesAgo(0),
        ip: "100.64.0.9", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17.0 Mobile Safari/604.1",
        current: false,
      },
    ],
  });
});

describe("DeviceAccessPanel · 活跃度 / 有效期 / 网页会话", () => {
  it("设备行显示在线状态、最后在线、IP 与过期", async () => {
    render(<DeviceAccessPanel allowDevices onAllowDevicesChange={() => {}} />);
    const online = await screen.findByTestId("device-access-row-online");
    expect(online).toHaveTextContent(tr("settings:deviceAccess.activity.online"));
    expect(online).toHaveTextContent("192.168.1.5");
    const idle = screen.getByTestId("device-access-row-idle");
    expect(idle).toHaveTextContent(tr("settings:deviceAccess.activity.minutes", { count: 12 }));
    expect(idle).toHaveTextContent(tr("settings:deviceAccess.expiry.neverShort"));
    const old = screen.getByTestId("device-access-row-old");
    expect(within(old).getByTestId("device-access-expired")).toHaveTextContent(tr("settings:deviceAccess.expiry.expired"));
    expect(within(old).getByRole("button", { name: tr("sidebar:devices.access.revoke") })).toBeInTheDocument();
  });

  it("网页登录会话作为第二个列表出现，可单独注销", async () => {
    const user = userEvent.setup();
    render(<DeviceAccessPanel allowDevices onAllowDevicesChange={() => {}} />);
    const row = await screen.findByTestId("web-session-row-abcdef01");
    expect(row).toHaveTextContent("Safari · iOS");
    expect(row).toHaveTextContent("100.64.0.9");
    await user.click(within(row).getByRole("button", { name: tr("settings:deviceAccess.webSessions.revoke") }));
    expect(accessService.revokeWebSession).toHaveBeenCalledWith("abcdef0123456789");
  });

  it("撤销其他全部：确认框写明数量，确认后才执行", async () => {
    const user = userEvent.setup();
    vi.mocked(nativeConfirm).mockResolvedValueOnce(false);
    render(<DeviceAccessPanel allowDevices onAllowDevicesChange={() => {}} />);
    await screen.findByTestId("web-session-row-abcdef01");
    await user.click(screen.getByTestId("device-access-revoke-others"));
    expect(nativeConfirm).toHaveBeenCalledWith(tr("settings:deviceAccess.revokeOthers.confirm", { devices: 3, sessions: 1 }));
    expect(accessService.revokeOtherAccess).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("device-access-revoke-others"));
    await waitFor(() => expect(accessService.revokeOtherAccess).toHaveBeenCalledTimes(1));
  });

  it("配对时按所选有效期生成配对码（默认 90 天，可选永不）", async () => {
    const user = userEvent.setup();
    vi.mocked(deviceService.startDevicePairing).mockResolvedValue({
      code: "123456", expiresAt: new Date(Date.now() + 300_000).toISOString(), addresses: [],
    });
    render(<DeviceAccessPanel allowDevices onAllowDevicesChange={() => {}} />);
    await user.click(screen.getByRole("combobox", { name: tr("settings:deviceAccess.expiry.label") }));
    await user.click(screen.getByRole("option", { name: tr("settings:deviceAccess.expiry.never") }));
    await user.click(screen.getByRole("button", { name: tr("sidebar:devices.access.createPairing") }));
    expect(deviceService.startDevicePairing).toHaveBeenCalledWith(0);
  });
});
