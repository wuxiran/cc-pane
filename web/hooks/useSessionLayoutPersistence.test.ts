import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectRestorableSessions,
  useSessionLayoutPersistence,
  useStartupTerminalRestoreBarrier,
} from "./useSessionLayoutPersistence";
import { sessionRestoreService, terminalService } from "@/services";
import { getCurrentWindowIfTauri, isTauriRuntime } from "@/services/runtime";
import { waitForDesktopRuntime } from "@/utils/desktopRuntime";
import { usePanesStore } from "@/stores";
import {
  reconcileTerminalSessions,
  runBackgroundLayoutRestore,
} from "@/hooks/useTerminalSessionRestore";

vi.mock("@/stores", () => ({
  usePanesStore: { getState: vi.fn() },
  useWorkspacesStore: {
    getState: vi.fn(() => ({ selectedWorkspace: () => null })),
  },
  useSettingsStore: {
    getState: vi.fn(() => ({
      settings: { terminal: { autoAdoptDaemonSessions: true } },
    })),
  },
}));

vi.mock("@/services", () => ({
  sessionRestoreService: { save: vi.fn() },
  layoutSnapshotService: { save: vi.fn(), load: vi.fn() },
  terminalService: { getCachedDaemonClientInfo: vi.fn(() => null) },
}));

vi.mock("@/services/runtime", () => ({
  getCurrentWindowIfTauri: vi.fn(),
  isTauriRuntime: vi.fn(() => true),
}));

vi.mock("@/utils/desktopRuntime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/desktopRuntime")>()),
  waitForDesktopRuntime: vi.fn(),
  // resolveRuntimeKind 走真实实现：运行时指纹的正确性正是本文件要守的东西
}));

vi.mock("@/hooks/useTerminalSessionRestore", () => ({
  restoreLiveDaemonSessionsFromBackend: vi.fn(async () => 0),
  reconcileTerminalSessions: vi.fn(async () => ({ attached: 0, blocked: 0, skipped: 0 })),
  runBackgroundLayoutRestore: vi.fn(async () => {}),
}));

describe("useStartupTerminalRestoreBarrier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    vi.mocked(waitForDesktopRuntime).mockResolvedValue(true);
  });

  it("retries blocked adoption once after the default daemon lease expires", async () => {
    vi.mocked(reconcileTerminalSessions)
      .mockResolvedValueOnce({ attached: 0, blocked: 1, skipped: 0 })
      .mockResolvedValueOnce({ attached: 1, blocked: 0, skipped: 0 });

    const { result, unmount } = renderHook(() => useStartupTerminalRestoreBarrier());

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(30_999));
    expect(reconcileTerminalSessions).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(reconcileTerminalSessions).toHaveBeenCalledTimes(2);
    expect(reconcileTerminalSessions).toHaveBeenLastCalledWith({ autoAdopt: true });
    expect(runBackgroundLayoutRestore).toHaveBeenCalledTimes(2);

    unmount();
    vi.useRealTimers();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useSessionLayoutPersistence cancelled 防护", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    vi.mocked(usePanesStore.getState).mockReturnValue({
      getRestorableTabs: () => [
        {
          tab: {
            id: "t1",
            contentType: "terminal",
            projectPath: "/p1",
            terminalRootPane: {
              type: "leaf",
              id: "leaf-1",
              sessionId: "pty-1",
            },
          },
          paneId: "pane-1",
          layoutId: "layout-1",
        },
      ],
      exportLayoutSnapshotPayload: () => ({}),
    } as never);
  });

  it("runtime ready 晚于卸载时，不注册监听与定时器", async () => {
    vi.useFakeTimers();
    const runtimeReady = deferred<boolean>();
    vi.mocked(waitForDesktopRuntime).mockReturnValue(runtimeReady.promise);
    const onCloseRequested = vi.fn();
    vi.mocked(getCurrentWindowIfTauri).mockReturnValue({ onCloseRequested } as never);

    const { unmount } = renderHook(() => useSessionLayoutPersistence());
    unmount();
    runtimeReady.resolve(true);
    await vi.advanceTimersByTimeAsync(0);

    // cancelled 在 await 前置检查即返回，连 onCloseRequested 都不应注册
    expect(onCloseRequested).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(sessionRestoreService.save).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("onCloseRequested await 期间卸载时，注册完成后立即释放监听", async () => {
    vi.useFakeTimers();
    vi.mocked(waitForDesktopRuntime).mockResolvedValue(true);
    const unlisten = vi.fn();
    const listenerRegistered = deferred<void>();
    let releaseRegistration!: () => void;
    const registrationGate = new Promise<void>((res) => {
      releaseRegistration = res;
    });
    const onCloseRequested = vi.fn(async () => {
      listenerRegistered.resolve();
      await registrationGate;
      return unlisten;
    });
    vi.mocked(getCurrentWindowIfTauri).mockReturnValue({ onCloseRequested } as never);

    const { unmount } = renderHook(() => useSessionLayoutPersistence());
    await vi.advanceTimersByTimeAsync(0);
    await listenerRegistered.promise;

    // 注册尚未完成（await 挂起）时卸载
    unmount();
    releaseRegistration();
    await vi.advanceTimersByTimeAsync(0);

    expect(unlisten).toHaveBeenCalledTimes(1);

    // 定时器也不应被注册
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sessionRestoreService.save).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("正常挂载时定时器周期性保存会话", async () => {
    vi.useFakeTimers();
    vi.mocked(waitForDesktopRuntime).mockResolvedValue(true);
    vi.mocked(getCurrentWindowIfTauri).mockReturnValue(null as never);
    vi.mocked(sessionRestoreService.save).mockResolvedValue(undefined as never);

    const { unmount } = renderHook(() => useSessionLayoutPersistence());
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sessionRestoreService.save).toHaveBeenCalledTimes(1);

    unmount();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sessionRestoreService.save).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("collectRestorableSessions", () => {
  function mockTabs(tabs: unknown[]) {
    vi.mocked(usePanesStore.getState).mockReturnValue({
      getRestorableTabs: () => tabs,
      exportLayoutSnapshotPayload: () => ({}),
    } as never);
  }

  it("分屏 tab 的每个 leaf 各存一行，带精确挂载锚点", () => {
    mockTabs([
      {
        tab: {
          id: "t1",
          title: "split tab",
          contentType: "terminal",
          projectPath: "/p1",
          terminalRootPane: {
            type: "split",
            id: "split-1",
            direction: "row",
            children: [
              { type: "leaf", id: "leaf-a", sessionId: "pty-a" },
              { type: "leaf", id: "leaf-b", sessionId: "pty-b" },
            ],
          },
        },
        paneId: "pane-1",
        layoutId: "layout-1",
      },
    ]);

    const rows = collectRestorableSessions();
    expect(rows.map((r) => r.sessionId)).toEqual(["pty-a", "pty-b"]);
    expect(rows.map((r) => r.terminalPaneId)).toEqual(["leaf-a", "leaf-b"]);
    expect(rows.every((r) => r.tabId === "t1" && r.layoutId === "layout-1")).toBe(true);
  });

  it("没有真实 PTY id 的 leaf 直接跳过，绝不拿 tab.id 冒充 sessionId", () => {
    mockTabs([
      {
        tab: {
          id: "t-no-session",
          contentType: "terminal",
          projectPath: "/p1",
          terminalRootPane: { type: "leaf", id: "leaf-x", sessionId: null },
        },
        paneId: "pane-1",
        layoutId: "layout-1",
      },
    ]);

    expect(collectRestorableSessions()).toEqual([]);
  });

  it("rehydrate 后的 savedSessionId 仍算真实会话", () => {
    mockTabs([
      {
        tab: {
          id: "t2",
          contentType: "terminal",
          projectPath: "/p1",
          terminalRootPane: {
            type: "leaf",
            id: "leaf-c",
            sessionId: null,
            savedSessionId: "pty-c",
          },
        },
        paneId: "pane-1",
        layoutId: "layout-1",
      },
    ]);

    expect(collectRestorableSessions().map((r) => r.sessionId)).toEqual(["pty-c"]);
  });

  it("WSL/SSH 会话保留完整运行时指纹", () => {
    mockTabs([
      {
        tab: {
          id: "t3",
          contentType: "terminal",
          projectPath: "/p1",
          terminalRootPane: {
            type: "leaf",
            id: "leaf-d",
            sessionId: "pty-d",
            wsl: { distro: "Ubuntu", remotePath: "/mnt/d/proj" },
          },
        },
        paneId: "pane-1",
        layoutId: "layout-1",
      },
    ]);

    const [row] = collectRestorableSessions();
    expect(row.runtimeKind).toBe("wsl");
    expect(JSON.parse(row.wslConfig!)).toEqual({ distro: "Ubuntu", remotePath: "/mnt/d/proj" });
  });

  it("周期观察写入当前 app instance，避免其他实例覆盖锚点", () => {
    vi.mocked(terminalService.getCachedDaemonClientInfo).mockReturnValue({
      mode: "daemon",
      claimsSupported: true,
      instanceId: "app-current",
    });
    mockTabs([{
      tab: {
        id: "t-owner",
        title: "owned",
        contentType: "terminal",
        projectPath: "/p1",
        terminalRootPane: { type: "leaf", id: "leaf-owner", sessionId: "pty-owner" },
      },
      paneId: "pane-1",
      layoutId: "layout-1",
    }]);

    expect(collectRestorableSessions()[0].observerInstanceId).toBe("app-current");
  });
});
