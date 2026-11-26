import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTerminalWriteWatchdog } from "./useTerminalWriteWatchdog";
import type { TerminalHiddenWriteBuffer } from "../terminalHiddenWriteBuffer";
import type { createTerminalWriteFlowControl } from "../terminalWriteFlowControl";

type FlowControl = ReturnType<typeof createTerminalWriteFlowControl>;

function makeBuffer(pending: number): TerminalHiddenWriteBuffer {
  return {
    push: () => null,
    drain: () => null,
    reset: () => {},
    didOverflow: () => false,
    pendingLength: () => pending,
    pendingChunkCount: () => (pending > 0 ? 1 : 0),
  };
}

function makeFlow(stats: { queuedWrites: number; oldestWaitMs: number }): FlowControl {
  return {
    write: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    queueLength: () => stats.queuedWrites,
    takeIntervalCallbackMaxMs: () => 0,
    getStats: () => ({
      queuedChars: 0, inFlightChars: 0, receivedChars: 0, writeCalls: 0, failedWrites: 0,
      callbackMaxMs: 0, inFlightWrites: 0, blocked: false, pendingCallbacks: 0, ...stats,
    }),
  };
}

function setup(options: {
  pending?: number;
  visible?: boolean;
  domVisible?: boolean;
  flow?: FlowControl | null;
  resync?: boolean;
  sessionId?: string;
  lastReceived?: number;
  daemonLast?: number | null;
  daemonRecent?: boolean;
  resyncRunning?: boolean;
}) {
  const flushHiddenWrites = vi.fn().mockResolvedValue("flushed");
  const overflowResync = Object.assign(vi.fn().mockResolvedValue(true), {
    isRunning: () => options.resyncRunning ?? false,
  });
  const onRendererFailure = vi.fn();
  const resyncInProgressRef = { current: options.resync ?? false };
  const debugLog = vi.fn();
  const terminalInstanceRef = {
    current: options.domVisible === false
      ? null
      : { element: { getClientRects: () => [{}] } },
  };
  const rebindOutput = vi.fn().mockResolvedValue(undefined);
  renderHook(() => useTerminalWriteWatchdog({
    isRenderVisible: () => options.visible ?? true,
    terminalInstanceRef: terminalInstanceRef as never,
    hiddenWriteBufferRef: { current: makeBuffer(options.pending ?? 0) },
    writeFlowControlRef: { current: options.flow === undefined ? makeFlow({ queuedWrites: 0, oldestWaitMs: 0 }) : options.flow },
    resyncInProgressRef,
    overflowResyncRef: { current: overflowResync },
    flushHiddenWrites,
    onRendererFailure,
    debugLog,
    currentSessionIdRef: { current: options.sessionId ?? null },
    lastOutputReceivedAtRef: { current: options.lastReceived ?? 0 },
    getDaemonLastOutputAt: async () =>
      options.daemonRecent ? Date.now() - 1_000 : (options.daemonLast ?? null),
    rebindOutput,
  }));
  return { flushHiddenWrites, overflowResync, resyncInProgressRef, debugLog, rebindOutput, onRendererFailure };
}

describe("useTerminalWriteWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes hidden backlog that accumulated while the pane is actually visible", async () => {
    const { flushHiddenWrites } = setup({ pending: 4096, visible: true });
    await vi.advanceTimersByTimeAsync(2_100);
    expect(flushHiddenWrites).toHaveBeenCalledWith("watchdog.pending-while-visible");
  });

  it("leaves hidden backlog alone while the pane is hidden", async () => {
    const { flushHiddenWrites } = setup({ pending: 4096, visible: false, domVisible: false });
    await vi.advanceTimersByTimeAsync(4_100);
    expect(flushHiddenWrites).not.toHaveBeenCalled();
  });

  it("trusts DOM facts when the visibility registry lies", async () => {
    // 注册表说 hidden（挂载竞态撒谎），但 document 可见且元素有尺寸 = 用户在看。
    const { flushHiddenWrites } = setup({ pending: 2048, visible: false, domVisible: true });
    await vi.advanceTimersByTimeAsync(2_100);
    expect(flushHiddenWrites).toHaveBeenCalledWith("watchdog.pending-while-visible");
  });

  it("disposes the stale writer before requesting renderer recovery", async () => {
    const flow = makeFlow({ queuedWrites: 3, oldestWaitMs: 20_000 });
    const { debugLog, onRendererFailure, overflowResync } = setup({ flow });
    await vi.advanceTimersByTimeAsync(2_100);
    expect(flow.dispose).toHaveBeenCalledTimes(1);
    expect(onRendererFailure).toHaveBeenCalledWith(expect.any(Error));
    expect(vi.mocked(flow.dispose).mock.invocationCallOrder[0]).toBeLessThan(onRendererFailure.mock.invocationCallOrder[0]);
    expect(overflowResync).not.toHaveBeenCalled();
    expect(debugLog).toHaveBeenCalledWith("watchdog.write-queue-stuck", expect.any(Object));
  });

  it("leaves a healthy queue and renderer alone", async () => {
    const flow = makeFlow({ queuedWrites: 3, oldestWaitMs: 10 });
    const { onRendererFailure } = setup({ flow });
    await vi.advanceTimersByTimeAsync(6_100);
    expect(flow.dispose).not.toHaveBeenCalled();
    expect(onRendererFailure).not.toHaveBeenCalled();
  });

  it("breaks a stalled resync gate and reruns recovery", async () => {
    const { overflowResync, resyncInProgressRef } = setup({ resync: true });
    await vi.advanceTimersByTimeAsync(33_000);
    expect(resyncInProgressRef.current).toBe(false);
    expect(overflowResync).toHaveBeenCalledTimes(1);
  });

  it("never opens the gate underneath a resync that is still writing", async () => {
    const { overflowResync, resyncInProgressRef, onRendererFailure } = setup({ resync: true, resyncRunning: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resyncInProgressRef.current).toBe(true);
    expect(overflowResync).not.toHaveBeenCalled();
    expect(onRendererFailure).not.toHaveBeenCalled();
  });

  it("rebuilds the view when a running resync is truly hung", async () => {
    const { overflowResync, resyncInProgressRef, onRendererFailure } = setup({ resync: true, resyncRunning: true });
    await vi.advanceTimersByTimeAsync(123_000);
    expect(onRendererFailure).toHaveBeenCalledTimes(1);
    expect(resyncInProgressRef.current).toBe(true);
    expect(overflowResync).not.toHaveBeenCalled();
  });

  it("leaves a hidden view's gate closed while it waits for the visible edge", async () => {
    const { overflowResync, resyncInProgressRef } = setup({ resync: true, visible: false, domVisible: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resyncInProgressRef.current).toBe(true);
    expect(overflowResync).not.toHaveBeenCalled();
  });

  it("cooldowns repeated recoveries of the same class", async () => {
    const flow = makeFlow({ queuedWrites: 3, oldestWaitMs: 20_000 });
    setup({ flow });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(flow.dispose).toHaveBeenCalledTimes(1);
  });

  it("rebinds output when daemon produced output the view never received", async () => {
    const { overflowResync, rebindOutput } = setup({
      sessionId: "s1",
      lastReceived: Date.now() - 30_000,
      daemonRecent: true,
    });
    await vi.advanceTimersByTimeAsync(2_100);
    expect(rebindOutput).toHaveBeenCalledTimes(1);
    expect(overflowResync).not.toHaveBeenCalled();
  });

  it("forces resync when output stays starved after rebind", async () => {
    const { overflowResync, rebindOutput } = setup({
      sessionId: "s1",
      lastReceived: Date.now() - 60_000,
      daemonRecent: true,
    });
    await vi.advanceTimersByTimeAsync(27_000);
    expect(rebindOutput).toHaveBeenCalledTimes(1);
    expect(overflowResync).toHaveBeenCalledTimes(1);
  });

  describe("有意断流不算饿死", () => {
    function setDocumentVisibility(state: DocumentVisibilityState) {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    }

    afterEach(() => {
      delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    });

    it("ignores starvation while the whole document is hidden", async () => {
      setDocumentVisibility("hidden");
      const { overflowResync, rebindOutput } = setup({
        sessionId: "s1",
        visible: true,
        lastReceived: Date.now() - 60_000,
        daemonRecent: true,
      });
      await vi.advanceTimersByTimeAsync(40_000);
      expect(rebindOutput).not.toHaveBeenCalled();
      expect(overflowResync).not.toHaveBeenCalled();
    });

    it("restarts the starvation window when the document returns", async () => {
      setDocumentVisibility("hidden");
      const { rebindOutput } = setup({
        sessionId: "s1",
        visible: true,
        lastReceived: Date.now() - 60_000,
        daemonRecent: true,
      });
      await vi.advanceTimersByTimeAsync(4_000);

      setDocumentVisibility("visible");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rebindOutput).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(6_000);
      expect(rebindOutput).toHaveBeenCalledTimes(1);
    });

    it("does not count output produced before the view came back", async () => {
      setDocumentVisibility("hidden");
      const daemonLast = Date.now() + 2_000;
      const { rebindOutput } = setup({
        sessionId: "s1",
        visible: true,
        lastReceived: Date.now() - 60_000,
        daemonLast,
      });
      await vi.advanceTimersByTimeAsync(4_000);

      setDocumentVisibility("visible");
      await vi.advanceTimersByTimeAsync(14_000);
      expect(rebindOutput).not.toHaveBeenCalled();
    });
  });

  it("never rebinds underneath an in-flight resync", async () => {
    const { rebindOutput } = setup({
      sessionId: "s1",
      resync: true,
      lastReceived: Date.now() - 30_000,
      daemonRecent: true,
    });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(rebindOutput).not.toHaveBeenCalled();
  });

  it("does not consult the daemon for hidden views", async () => {
    // 后台/休眠视图：daemon 有新产出、本视图没收到，也不该每 2s 去查 daemon。
    const { rebindOutput } = setup({
      sessionId: "s1",
      visible: false,
      domVisible: false,
      lastReceived: Date.now() - 60_000,
      daemonRecent: true,
    });
    await vi.advanceTimersByTimeAsync(27_000);
    expect(rebindOutput).not.toHaveBeenCalled();
  });

  it("does not treat a genuinely quiet session as starved", async () => {
    // daemon 最近 60s 无产出（旧历史不算饿）。
    const { rebindOutput } = setup({ sessionId: "s1", lastReceived: 0, daemonLast: Date.now() - 60_000 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(rebindOutput).not.toHaveBeenCalled();
  });

  it("does nothing while output flows normally", async () => {
    const { rebindOutput } = setup({ sessionId: "s1", lastReceived: Date.now() - 1_000, daemonLast: Date.now() - 1_000 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(rebindOutput).not.toHaveBeenCalled();
  });
});
