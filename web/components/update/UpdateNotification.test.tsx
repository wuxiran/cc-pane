import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { UpdateInstallProgress } from "@/services/updaterService";
import { useSettingsStore, useUpdateStore } from "@/stores";
import UpdateNotification, { shouldShowUpdateNotification } from "./UpdateNotification";

const gateMocks = vi.hoisted(() => ({
  check: vi.fn(() => null as string | null),
  occupy: vi.fn(),
  release: vi.fn(),
}));
// 安装前的忙碌确认不再走闸门（闸门对 update 已放行 agentBusy），改读这个。
const busyMocks = vi.hoisted(() => ({ hasBusySessions: vi.fn(() => false) }));
const updaterMocks = vi.hoisted(() => ({
  checkForAvailableUpdate: vi.fn(),
  downloadAndInstallUpdate: vi.fn(async (
    _update: unknown,
    _onProgress?: (progress: UpdateInstallProgress) => void,
  ) => undefined),
  getUpdateErrorHint: vi.fn(() => ""),
}));

vi.mock("@/lib/interruptGate", () => ({
  useInterruptGate: () => ({ activeInterrupt: null, ...gateMocks }),
  hasBusySessions: busyMocks.hasBusySessions,
}));

vi.mock("@/services/updaterService", () => updaterMocks);
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.11.1") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));

function renderNotification() {
  return render(
    <TooltipProvider>
      <UpdateNotification />
    </TooltipProvider>,
  );
}

describe("shouldShowUpdateNotification", () => {
  const base = {
    available: true,
    version: "0.12.0",
    notifyEnabled: true,
    skippedVersion: null,
    lastNotifiedAt: null,
    now: Date.parse("2026-07-25T12:00:00Z"),
  };

  it("放行新版本并拦截关闭、跳过和 24 小时静默期", () => {
    expect(shouldShowUpdateNotification(base)).toBe(true);
    expect(shouldShowUpdateNotification({ ...base, notifyEnabled: false })).toBe(false);
    expect(shouldShowUpdateNotification({ ...base, skippedVersion: "0.12.0" })).toBe(false);
    expect(shouldShowUpdateNotification({
      ...base,
      lastNotifiedAt: "2026-07-24T12:00:01Z",
    })).toBe(false);
    expect(shouldShowUpdateNotification({
      ...base,
      lastNotifiedAt: "2026-07-24T12:00:00Z",
    })).toBe(true);
  });

  it("跳过旧版本不阻止更高版本", () => {
    expect(shouldShowUpdateNotification({ ...base, skippedVersion: "0.11.9" })).toBe(true);
  });
});

describe("UpdateNotification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gateMocks.check.mockReturnValue(null);
    busyMocks.hasBusySessions.mockReturnValue(false);
    updaterMocks.downloadAndInstallUpdate.mockResolvedValue(undefined);
    updaterMocks.getUpdateErrorHint.mockReturnValue("");
    const settings = useSettingsStore.getState().getDefaults();
    useSettingsStore.setState({
      settings: {
        ...settings,
        update: { notifyEnabled: true, skippedVersion: null, lastNotifiedAt: null },
      },
      saveSettings: vi.fn(async (next) => {
        useSettingsStore.setState({ settings: next });
      }),
    });
    useUpdateStore.setState({
      available: true,
      version: "0.12.0",
      body: null,
    });
  });

  it("在独立右下角卡片显示空 changelog 降级文案并支持稍后", async () => {
    const user = userEvent.setup();
    renderNotification();

    expect(await screen.findByText(/发现新版本 v0.12.0|New version v0.12.0 available/i)).toBeInTheDocument();
    expect(screen.getByText(/功能改进和问题修复|improvements and bug fixes/i)).toBeInTheDocument();
    expect(gateMocks.occupy).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: /^(稍后|Later)$/i }));

    expect(screen.queryByText(/发现新版本 v0.12.0|New version v0.12.0 available/i)).not.toBeInTheDocument();
    expect(gateMocks.release).toHaveBeenCalled();
  });

  it("点击立即更新时复查忙碌状态并二次确认", async () => {
    const user = userEvent.setup();
    updaterMocks.checkForAvailableUpdate.mockResolvedValue({ version: "0.12.0" });
    updaterMocks.downloadAndInstallUpdate.mockImplementation(async (_update, onProgress) => {
      onProgress?.({
        phase: "downloading",
        downloadedBytes: 40,
        totalBytes: 100,
        percent: 40,
      });
    });
    renderNotification();
    await screen.findByText(/发现新版本 v0.12.0|New version v0.12.0 available/i);
    busyMocks.hasBusySessions.mockReturnValue(true);

    await user.click(screen.getByRole("button", { name: /立即更新|Update now/i }));

    expect(screen.getByText(/仍有 agent 正在运行|agent is still running/i)).toBeInTheDocument();
    busyMocks.hasBusySessions.mockReturnValue(false);
    await user.click(screen.getByRole("button", { name: /继续更新|Continue update/i }));

    await waitFor(() => expect(updaterMocks.downloadAndInstallUpdate).toHaveBeenCalledOnce());
    expect(busyMocks.hasBusySessions).toHaveBeenCalled();
    expect(screen.getByText("40%")).toBeInTheDocument();
  });

  // 闸门对 update 放行 agentBusy 后，最容易误伤的就是这道警告：卡片能显示了，
  // 但安装会重启应用杀掉在跑的活，警告必须还在。
  it("闸门放行 agentBusy 后，安装前仍然警告有 agent 在跑", async () => {
    const user = userEvent.setup();
    gateMocks.check.mockReturnValue(null);
    busyMocks.hasBusySessions.mockReturnValue(true);
    updaterMocks.checkForAvailableUpdate.mockResolvedValue({ version: "0.12.0" });
    renderNotification();

    await screen.findByText(/发现新版本 v0.12.0|New version v0.12.0 available/i);
    await user.click(screen.getByRole("button", { name: /立即更新|Update now/i }));

    expect(screen.getByText(/仍有 agent 正在运行|agent is still running/i)).toBeInTheDocument();
    expect(updaterMocks.downloadAndInstallUpdate).not.toHaveBeenCalled();
  });

  it("安装失败时在原卡片显示可读错误、重试和下载页", async () => {
    const user = userEvent.setup();
    updaterMocks.checkForAvailableUpdate.mockRejectedValue(new Error("connect timeout"));
    updaterMocks.getUpdateErrorHint.mockReturnValue("请检查代理设置");
    renderNotification();
    await screen.findByText(/发现新版本 v0.12.0|New version v0.12.0 available/i);

    await user.click(screen.getByRole("button", { name: /立即更新|Update now/i }));
    await user.click(screen.getByRole("button", { name: /继续更新|Continue update/i }));

    expect(await screen.findByText(/更新失败|Update failed/i)).toBeInTheDocument();
    expect(screen.getByText(/connect timeout/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /重试|Retry/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /去下载页|Download page/i })).toBeInTheDocument();
  });

  it("跳过仅持久化当前版本", async () => {
    const user = userEvent.setup();
    renderNotification();
    await screen.findByText(/发现新版本 v0.12.0|New version v0.12.0 available/i);

    await user.click(screen.getByRole("button", { name: /跳过此版本|Skip this version/i }));

    await waitFor(() => {
      expect(useSettingsStore.getState().settings?.update.skippedVersion).toBe("0.12.0");
    });
  });
});
