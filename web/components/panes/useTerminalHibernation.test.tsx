import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { SerializeAddon } from "@xterm/addon-serialize";
import { BACKGROUND_PARK_DELAY_MS, BACKGROUND_TIER1_DELAY_MS } from "./terminalBackgroundLifecycle";
import type { TerminalRendererController } from "./terminalRendererController";
import { terminalParkingRegistry } from "./terminalParking";
import { replayHibernationWake, useTerminalHibernation } from "./useTerminalHibernation";

vi.mock("./terminalCheckpointUpload", () => ({
  captureAndUploadCheckpoint: vi.fn(async () => undefined),
}));

function createHarness() {
  const term = { cols: 132, rows: 43 } as unknown as Terminal;
  const renderer = { suspendWebgl: vi.fn(), resumeWebgl: vi.fn() } as unknown as TerminalRendererController;
  const options = {
    terminalInstanceRef: { current: term as Terminal | null },
    currentSessionIdRef: { current: "sess-1" as string | null },
    serializeAddonRef: { current: null as SerializeAddon | null },
    hiddenWriteBufferRef: { current: null },
    rendererControllerRef: { current: renderer as TerminalRendererController | null },
    isReconnectingRef: { current: false },
    isDisconnectedRef: { current: false },
    debugLog: vi.fn(),
    bumpInstanceEpoch: vi.fn(),
  };
  const hook = renderHook(() => useTerminalHibernation(options));
  return { ...options, renderer, hook };
}

describe("useTerminalHibernation · 停泊集成", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("隐藏 30 s 停泊：交接空基底容器 + epoch 自增（init cleanup 随之 dispose xterm）；cols/rows 保留", () => {
    const h = createHarness();
    act(() => h.hook.result.current.notifyVisibility(false));
    act(() => { vi.advanceTimersByTime(BACKGROUND_TIER1_DELAY_MS); });
    expect(h.renderer.suspendWebgl).toHaveBeenCalledWith("background");
    expect(h.hook.result.current.hibernatedStateRef.current).toBeNull();

    act(() => { vi.advanceTimersByTime(BACKGROUND_PARK_DELAY_MS - BACKGROUND_TIER1_DELAY_MS); });
    const parked = h.hook.result.current.hibernatedStateRef.current;
    expect(parked).not.toBeNull();
    expect(parked?.sessionId).toBe("sess-1");
    expect(parked?.cols).toBe(132);
    expect(parked?.rows).toBe(43);
    expect(parked?.wakeData()).toBeNull();
    expect(h.bumpInstanceEpoch).toHaveBeenCalledTimes(1);
    expect(h.debugLog).toHaveBeenCalledWith("park.begin", expect.objectContaining({ reason: "park-timer" }));
    // 停泊后注册表不再把它算作「隐藏且活着」
    expect(terminalParkingRegistry.hiddenCount()).toBe(0);
  });

  it("停泊后变可见：容器移交 wakeStateRef，epoch 再次自增；唤醒回放走 replayFromSnapshot", async () => {
    const h = createHarness();
    act(() => h.hook.result.current.notifyVisibility(false));
    act(() => { vi.advanceTimersByTime(BACKGROUND_PARK_DELAY_MS); });
    expect(h.bumpInstanceEpoch).toHaveBeenCalledTimes(1);

    act(() => h.hook.result.current.notifyVisibility(true));
    expect(h.hook.result.current.hibernatedStateRef.current).toBeNull();
    const wake = h.hook.result.current.wakeStateRef.current;
    expect(wake).not.toBeNull();
    expect(h.bumpInstanceEpoch).toHaveBeenCalledTimes(2);
    expect(h.renderer.resumeWebgl).toHaveBeenCalledWith("view-visible");

    const replayFromSnapshot = vi.fn(async () => undefined);
    const writeTerminalData = vi.fn(async () => undefined);
    const resizes: Array<[number, number]> = [];
    await replayHibernationWake({
      wake: wake!,
      term: {
        writeln: vi.fn(), cols: 80, rows: 24,
        resize: (cols: number, rows: number) => { resizes.push([cols, rows]); },
      } as never,
      writeTerminalData,
      syncTrackedBufferType: vi.fn(),
      replayFromSnapshot,
      showReconnectHint: false,
      debugLog: vi.fn(),
    });
    expect(replayFromSnapshot).toHaveBeenCalledTimes(1);
    expect(writeTerminalData).not.toHaveBeenCalled();
    expect(resizes).toEqual([[132, 43]]);
  });

  it("注册表逐出的停泊（不经定时器）可见时同样唤醒", () => {
    const h = createHarness();
    act(() => h.hook.result.current.notifyVisibility(false));
    // 注册表上限 1：第二个隐藏终端登记时按 LRU 逐出第一个（不等 30 s 定时器）
    expect(terminalParkingRegistry.hiddenCount()).toBe(1);
    terminalParkingRegistry.setLimit(1);
    const other = createHarness();
    act(() => other.hook.result.current.notifyVisibility(false));
    expect(h.hook.result.current.hibernatedStateRef.current).not.toBeNull();
    expect(h.bumpInstanceEpoch).toHaveBeenCalledTimes(1);
    expect(other.hook.result.current.hibernatedStateRef.current).toBeNull();
    expect(h.debugLog).toHaveBeenCalledWith("park.begin", expect.objectContaining({ reason: "park-evict" }));
    expect(terminalParkingRegistry.hiddenCount()).toBe(1);
    other.hook.unmount();
    terminalParkingRegistry.setLimit(Number.NaN);

    act(() => h.hook.result.current.notifyVisibility(true));
    expect(h.hook.result.current.hibernatedStateRef.current).toBeNull();
    expect(h.hook.result.current.wakeStateRef.current).not.toBeNull();
    expect(h.bumpInstanceEpoch).toHaveBeenCalledTimes(2);
    // 之后的停泊定时器不得再次停泊（已唤醒并取消计时）
    act(() => { vi.advanceTimersByTime(BACKGROUND_PARK_DELAY_MS * 2); });
    expect(h.bumpInstanceEpoch).toHaveBeenCalledTimes(2);
  });

  it("停泊前变可见只恢复 WebGL，不触发交接", () => {
    const h = createHarness();
    act(() => h.hook.result.current.notifyVisibility(false));
    act(() => { vi.advanceTimersByTime(BACKGROUND_PARK_DELAY_MS - 1); });
    act(() => h.hook.result.current.notifyVisibility(true));
    expect(h.renderer.resumeWebgl).toHaveBeenCalledWith("foreground");
    expect(h.hook.result.current.hibernatedStateRef.current).toBeNull();
    expect(h.bumpInstanceEpoch).not.toHaveBeenCalled();
    expect(terminalParkingRegistry.hiddenCount()).toBe(0);
  });

  it("卸载时退出注册表", () => {
    const h = createHarness();
    act(() => h.hook.result.current.notifyVisibility(false));
    expect(terminalParkingRegistry.hiddenCount()).toBe(1);
    h.hook.unmount();
    expect(terminalParkingRegistry.hiddenCount()).toBe(0);
  });
});
