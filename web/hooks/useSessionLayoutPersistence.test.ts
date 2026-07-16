import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionLayoutPersistence } from "./useSessionLayoutPersistence";
import { sessionRestoreService } from "@/services";
import { getCurrentWindowIfTauri, isTauriRuntime } from "@/services/runtime";
import { waitForDesktopRuntime } from "@/utils/desktopRuntime";
import { usePanesStore } from "@/stores";

vi.mock("@/stores", () => ({
  usePanesStore: { getState: vi.fn() },
  useWorkspacesStore: {
    getState: vi.fn(() => ({ selectedWorkspace: () => null })),
  },
}));

vi.mock("@/services", () => ({
  sessionRestoreService: { save: vi.fn() },
  layoutSnapshotService: { save: vi.fn(), load: vi.fn() },
}));

vi.mock("@/services/runtime", () => ({
  getCurrentWindowIfTauri: vi.fn(),
  isTauriRuntime: vi.fn(() => true),
}));

vi.mock("@/utils/desktopRuntime", () => ({
  waitForDesktopRuntime: vi.fn(),
  resolveRuntimeKind: vi.fn(() => "local"),
}));

vi.mock("@/hooks/useTerminalSessionRestore", () => ({
  restoreLiveDaemonSessionsFromBackend: vi.fn(async () => 0),
  runBackgroundLayoutRestore: vi.fn(async () => {}),
}));

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
          tab: { id: "t1", contentType: "terminal", projectPath: "/p1" },
          paneId: "pane-1",
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
