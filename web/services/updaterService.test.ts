import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { check } from "@tauri-apps/plugin-updater";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  checkUpdateSilent,
  checkForAppUpdates,
  downloadAndInstallUpdate,
  getUpdateErrorHint,
  triggerUpdate,
} from "./updaterService";
import { useTerminalStatusStore, useUpdateStore } from "@/stores";

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(() => Promise.resolve()),
}));

const { stopWebAccessMock, stopTerminalDaemonMock } = vi.hoisted(() => ({
  stopWebAccessMock: vi.fn(async () => undefined),
  stopTerminalDaemonMock: vi.fn(async () => undefined),
}));

vi.mock("./settingsService", () => ({
  settingsService: {
    stopWebAccess: stopWebAccessMock,
    stopTerminalDaemon: stopTerminalDaemonMock,
  },
}));

const checkMock = check as unknown as ReturnType<typeof vi.fn>;
const askMock = ask as unknown as ReturnType<typeof vi.fn>;
const messageMock = message as unknown as ReturnType<typeof vi.fn>;

const originalTauriInternals = window.__TAURI_INTERNALS__;

function createUpdate(overrides: Record<string, unknown> = {}) {
  return {
    version: "1.2.3",
    body: "release notes",
    downloadAndInstall: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

describe("updaterService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.__TAURI_INTERNALS__ = originalTauriInternals ?? {};
    useUpdateStore.setState({
      available: false,
      version: null,
      body: null,
      lastCheckError: null,
      lastCheckFailedAt: null,
    });
    useTerminalStatusStore.setState({ statusMap: new Map() } as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    window.__TAURI_INTERNALS__ = originalTauriInternals;
    vi.restoreAllMocks();
  });

  describe("checkUpdateSilent", () => {
    it("应该在有更新时写入 store", async () => {
      checkMock.mockResolvedValue(createUpdate());

      await checkUpdateSilent();

      const state = useUpdateStore.getState();
      expect(state.available).toBe(true);
      expect(state.version).toBe("1.2.3");
      expect(state.body).toBe("release notes");
    });

    it("应该在无更新时清空 store", async () => {
      useUpdateStore.getState().setUpdate("1.0.0", null);
      checkMock.mockResolvedValue(null);

      await checkUpdateSilent();

      expect(useUpdateStore.getState().available).toBe(false);
    });

    it("应该在检查失败时静默处理不抛出", async () => {
      checkMock.mockRejectedValue(new Error("network error"));

      await expect(checkUpdateSilent()).resolves.toBeUndefined();
      expect(useUpdateStore.getState().available).toBe(false);
    });

    // 失败不能只进 console：本项目 GitHub 直连已知不稳，完全吞掉的话
    // 用户得到的信号是「这软件从来不更新」。
    it("检查失败时记录原因与时间，且不弹任何东西", async () => {
      checkMock.mockRejectedValue(new Error("network error"));

      await checkUpdateSilent();

      const state = useUpdateStore.getState();
      expect(state.lastCheckError).toContain("network error");
      expect(state.lastCheckFailedAt).not.toBeNull();
      expect(askMock).not.toHaveBeenCalled();
      expect(messageMock).not.toHaveBeenCalled();
    });

    // 断网不代表上次查到的更新没了；清掉会让「本来提示有更新、断一次网就消失」。
    it("检查失败时保留上一次查到的可用更新", async () => {
      useUpdateStore.getState().setUpdate("1.2.3", "release notes");
      checkMock.mockRejectedValue(new Error("network error"));

      await checkUpdateSilent();

      const state = useUpdateStore.getState();
      expect(state.available).toBe(true);
      expect(state.version).toBe("1.2.3");
      expect(state.lastCheckError).toContain("network error");
    });

    it("再次检查成功后清掉失败痕迹", async () => {
      checkMock.mockRejectedValue(new Error("network error"));
      await checkUpdateSilent();
      expect(useUpdateStore.getState().lastCheckError).not.toBeNull();

      checkMock.mockResolvedValue(createUpdate());
      await checkUpdateSilent();

      const state = useUpdateStore.getState();
      expect(state.lastCheckError).toBeNull();
      expect(state.lastCheckFailedAt).toBeNull();
    });

    it("应该在 Web 运行时直接返回", async () => {
      delete window.__TAURI_INTERNALS__;

      await checkUpdateSilent();

      expect(checkMock).not.toHaveBeenCalled();
    });
  });

  describe("checkForAppUpdates", () => {
    it("静默模式：有更新时只写 store 不弹窗", async () => {
      checkMock.mockResolvedValue(createUpdate());

      await checkForAppUpdates(false);

      expect(useUpdateStore.getState().available).toBe(true);
      expect(askMock).not.toHaveBeenCalled();
      expect(messageMock).not.toHaveBeenCalled();
    });

    it("用户主动检查：无更新时弹已是最新提示", async () => {
      checkMock.mockResolvedValue(null);

      await checkForAppUpdates(true);

      expect(messageMock).toHaveBeenCalledWith(
        "当前已是最新版本。",
        expect.objectContaining({ kind: "info" }),
      );
    });

    it("用户确认后应该下载安装并重启", async () => {
      const update = createUpdate();
      checkMock.mockResolvedValue(update);
      askMock.mockResolvedValue(true);

      await checkForAppUpdates(true);

      expect(update.downloadAndInstall).toHaveBeenCalled();
      expect(relaunch).toHaveBeenCalled();
    });

    it("用户取消后不应该下载", async () => {
      const update = createUpdate();
      checkMock.mockResolvedValue(update);
      askMock.mockResolvedValue(false);

      await checkForAppUpdates(true);

      expect(update.downloadAndInstall).not.toHaveBeenCalled();
      expect(relaunch).not.toHaveBeenCalled();
    });

    it("用户主动检查失败时应该弹错误提示", async () => {
      checkMock.mockRejectedValue(new Error("connect timeout"));

      await checkForAppUpdates(true);

      expect(messageMock).toHaveBeenCalledWith(
        expect.stringContaining("检查更新失败"),
        expect.objectContaining({ kind: "error" }),
      );
    });

    it("静默检查失败时不应该弹窗", async () => {
      checkMock.mockRejectedValue(new Error("network error"));

      await checkForAppUpdates(false);

      expect(messageMock).not.toHaveBeenCalled();
    });
  });

  describe("triggerUpdate", () => {
    it("应该在无更新时清空 store 并提示", async () => {
      useUpdateStore.getState().setUpdate("1.0.0", null);
      checkMock.mockResolvedValue(null);

      await triggerUpdate();

      expect(useUpdateStore.getState().available).toBe(false);
      expect(messageMock).toHaveBeenCalledWith(
        "当前已是最新版本。",
        expect.objectContaining({ kind: "info" }),
      );
    });

    it("应该在有更新且用户确认时执行安装", async () => {
      const update = createUpdate();
      checkMock.mockResolvedValue(update);
      askMock.mockResolvedValue(true);

      await triggerUpdate();

      expect(update.downloadAndInstall).toHaveBeenCalled();
      expect(relaunch).toHaveBeenCalled();
    });

    it("应该在 Web 运行时直接返回", async () => {
      delete window.__TAURI_INTERNALS__;

      await triggerUpdate();

      expect(checkMock).not.toHaveBeenCalled();
    });

    // 状态栏/首页/关于页三个入口都走这条原生确认路径；更新卡片路径另有自己的
    // busyAtConfirmation 警告。少了这条，从那三处点更新就是无声中断在跑的会话。
    it("有会话在忙时确认框必须带中断警告", async () => {
      useTerminalStatusStore.setState({
        statusMap: new Map([["s1", { sessionId: "s1", status: "thinking" }]]),
      } as never);
      checkMock.mockResolvedValue(createUpdate());
      askMock.mockResolvedValue(false);

      await triggerUpdate();

      expect(askMock).toHaveBeenCalledWith(
        expect.stringContaining("当前有会话正在运行"),
        expect.anything(),
      );
    });

    it("无会话在忙时确认框不带中断警告", async () => {
      useTerminalStatusStore.setState({ statusMap: new Map() } as never);
      checkMock.mockResolvedValue(createUpdate());
      askMock.mockResolvedValue(false);

      await triggerUpdate();

      expect(askMock).toHaveBeenCalledWith(
        expect.not.stringContaining("当前有会话正在运行"),
        expect.anything(),
      );
    });
  });

  describe("downloadAndInstallUpdate", () => {
    it("报告真实累计下载进度并在安装前停止后台服务", async () => {
      const downloadAndInstall = vi.fn(async (onProgress: (event: unknown) => void) => {
        onProgress({ event: "Started", data: { contentLength: 100 } });
        onProgress({ event: "Progress", data: { chunkLength: 40 } });
        onProgress({ event: "Progress", data: { chunkLength: 60 } });
        onProgress({ event: "Finished" });
      });
      const progress = vi.fn();

      await downloadAndInstallUpdate(createUpdate({ downloadAndInstall }) as never, progress);

      expect(stopWebAccessMock).toHaveBeenCalledOnce();
      expect(stopTerminalDaemonMock).toHaveBeenCalledOnce();
      expect(progress).toHaveBeenNthCalledWith(2, expect.objectContaining({
        phase: "downloading",
        downloadedBytes: 40,
        percent: 40,
      }));
      expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({
        phase: "installing",
        percent: 100,
      }));
      expect(relaunch).toHaveBeenCalledOnce();
    });

    it("为中英文返回可读网络错误提示", () => {
      expect(getUpdateErrorHint("request timed out", "zh-CN")).toContain("设置 → 代理");
      expect(getUpdateErrorHint("request timed out", "en")).toContain("Settings → Proxy");
    });
  });
});
