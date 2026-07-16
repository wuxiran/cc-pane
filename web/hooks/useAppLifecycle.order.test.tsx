// effect 顺序特征测试：MainApp 中生命周期 hook 的调用顺序必须保持原 App.tsx
// 的 effect 注册顺序（early → resumeId 桥接 → late）。若此测试失败，说明有人
// 调整了 hook 内 effect 顺序或 hook 分组，需先证明顺序无关再改断言。
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppLifecycleEarly } from "./useAppLifecycleEarly";
import { useAppLifecycleLate } from "./useAppLifecycleLate";
import { useTerminalResumeIdBridge } from "./useTerminalSessionRestore";
import { registerGlobalApi } from "@/utils/globalApi";
import { listenIfTauri, listenWebviewIfTauri } from "@/services/runtime";

const sequence = vi.hoisted(() => [] as string[]);

vi.mock("@/stores", () => {
  const storeStub = {
    getState: vi.fn(() => ({
      cleanup: vi.fn(),
      init: vi.fn(),
    })),
  };
  const useSettingsStore = Object.assign(
    (selector: (s: { settings: null }) => unknown) => selector({ settings: null }),
    { getState: vi.fn(() => ({ loadSettings: vi.fn(async () => {}), settings: null })) },
  );
  return {
    usePanesStore: storeStub,
    useThemeStore: storeStub,
    useTerminalStatusStore: storeStub,
    useNotificationStore: storeStub,
    useSettingsStore,
    useLaunchProfilesStore: storeStub,
    useResourceStatsStore: storeStub,
    useEnvironmentStore: storeStub,
  };
});

vi.mock("@/services", () => ({
  historyService: { touchBySessionId: vi.fn() },
  checkUpdateSilent: vi.fn(),
  markTabReclaimed: vi.fn(),
  getPoppedTabs: vi.fn(() => new Map()),
}));

vi.mock("@/services/runtime", () => ({
  isTauriRuntime: vi.fn(() => true),
  listenIfTauri: vi.fn(async () => () => {}),
  listenWebviewIfTauri: vi.fn(async () => () => {}),
  invokeIfTauri: vi.fn(async () => {}),
}));

vi.mock("@/utils/desktopRuntime", () => ({
  // 永不 resolve：只观察同步注册段的顺序
  waitForDesktopRuntime: vi.fn(() => new Promise<boolean>(() => {})),
}));

vi.mock("@/utils/globalApi", () => ({
  registerGlobalApi: vi.fn(),
}));

vi.mock("@/utils/notificationSound", () => ({
  playNotificationSound: vi.fn(async () => {}),
}));

vi.mock("@/utils/restoreReport", () => ({
  logRestoreReport: vi.fn(async () => {}),
}));

vi.mock("@/i18n", () => ({
  default: { language: "zh", changeLanguage: vi.fn(), t: (k: string) => k },
}));

describe("MainApp 生命周期 effect 顺序特征", () => {
  beforeEach(() => {
    sequence.length = 0;
    vi.mocked(registerGlobalApi).mockImplementation(() => {
      sequence.push("register-global-api");
    });
    vi.mocked(listenWebviewIfTauri).mockImplementation(async (event: string) => {
      sequence.push(`webview:${event}`);
      return () => {};
    });
    vi.mocked(listenIfTauri).mockImplementation((async (event: string) => {
      sequence.push(`listen:${event}`);
      return () => {};
    }) as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("early → resumeId 桥接 → late 的同步注册顺序保持不变", () => {
    const addEventListener = window.addEventListener.bind(window);
    const addSpy = vi.spyOn(window, "addEventListener").mockImplementation(
      (type, listener, options) => {
        if (type === "keydown") sequence.push("keydown:recent-files");
        addEventListener(type, listener as EventListener, options);
      },
    );

    const { unmount } = renderHook(() => {
      useAppLifecycleEarly();
      useTerminalResumeIdBridge();
      return useAppLifecycleLate();
    });

    expect(sequence).toEqual([
      "register-global-api",
      "webview:terminal-exit",
      "listen:history-updated",
      "keydown:recent-files",
      "listen:popup-window-closing",
      "listen:tauri://window-destroyed",
    ]);

    addSpy.mockRestore();
    unmount();
  });
});
