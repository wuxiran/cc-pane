import { describe, expect, it, vi } from "vitest";
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
  rebindOutput?: () => Promise<unknown>;
}) {
  const flushHiddenWrites = vi.fn().mockResolvedValue("flushed");
  const overflowResync = vi.fn().mockResolvedValue(true);
  const onRendererFailure = vi.fn();
  const resyncInProgressRef = { current: options.resync ?? false };
  const debugLog = vi.fn();
  const terminalInstanceRef = {
    current: options.domVisible === false
      ? null
      : { element: { getClientRects: () => [{}] } },
  };
  const rebindOutput = options.rebindOutput ?? vi.fn().mockResolvedValue(undefined);
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
  it("flushes hidden backlog that accumulated while the pane is actually visible", async () => {
    vi.useFakeTimers();
    try {
      const { flushHiddenWrites } = setup({ pending: 4096, visible: true });
      await vi.advanceTimersByTimeAsync(2_100);
      expect(flushHiddenWrites).toHaveBeenCalledWith("watchdog.pending-while-visible");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves hidden backlog alone while the pane is hidden", async () => {
    vi.useFakeTimers();
    try {
      const { flushHiddenWrites } = setup({ pending: 4096, visible: false, domVisible: false });
      await vi.advanceTimersByTimeAsync(4_100);
      expect(flushHiddenWrites).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("trusts DOM facts when the visibility registry lies", async () => {
    vi.useFakeTimers();
    try {
      // 注册表说 hidden（挂载竞态撒谎），但 document 可见且元素有尺寸 = 用户在看。
      const { flushHiddenWrites } = setup({ pending: 2048, visible: false, domVisible: true });
      await vi.advanceTimersByTimeAsync(2_100);
      expect(flushHiddenWrites).toHaveBeenCalledWith("watchdog.pending-while-visible");
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposes the stale writer before requesting renderer recovery", async () => {
    vi.useFakeTimers();
    try {
      const flow = makeFlow({ queuedWrites: 3, oldestWaitMs: 20_000 });
      const { debugLog, onRendererFailure, overflowResync } = setup({ flow });
      await vi.advanceTimersByTimeAsync(2_100);
      expect(flow.dispose).toHaveBeenCalledTimes(1);
      expect(onRendererFailure).toHaveBeenCalledWith(expect.any(Error));
      expect(vi.mocked(flow.dispose).mock.invocationCallOrder[0]).toBeLessThan(onRendererFailure.mock.invocationCallOrder[0]);
      expect(overflowResync).not.toHaveBeenCalled();
      expect(debugLog).toHaveBeenCalledWith("watchdog.write-queue-stuck", expect.any(Object));
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a healthy queue and renderer alone", async () => {
    vi.useFakeTimers();
    try {
      const flow = makeFlow({ queuedWrites: 3, oldestWaitMs: 10 });
      const { onRendererFailure } = setup({ flow });
      await vi.advanceTimersByTimeAsync(6_100);
      expect(flow.dispose).not.toHaveBeenCalled();
      expect(onRendererFailure).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("breaks a stalled resync gate and reruns recovery", async () => {
    vi.useFakeTimers();
    try {
      const { overflowResync, resyncInProgressRef } = setup({ resync: true });
      await vi.advanceTimersByTimeAsync(33_000);
      expect(resyncInProgressRef.current).toBe(false);
      expect(overflowResync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cooldowns repeated recoveries of the same class", async () => {
    vi.useFakeTimers();
    try {
      const flow = makeFlow({ queuedWrites: 3, oldestWaitMs: 20_000 });
      setup({ flow });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(flow.dispose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebinds output when daemon produced output the view never received", async () => {
    vi.useFakeTimers();
    try {
      const rebindOutput = vi.fn().mockResolvedValue(undefined);
      const { overflowResync } = setup({
        sessionId: "s1",
        lastReceived: Date.now() - 30_000,
        daemonRecent: true,
        rebindOutput,
      });
      await vi.advanceTimersByTimeAsync(2_100);
      expect(rebindOutput).toHaveBeenCalledTimes(1);
      expect(overflowResync).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forces resync when output stays starved after rebind", async () => {
    vi.useFakeTimers();
    try {
      const rebindOutput = vi.fn().mockResolvedValue(undefined);
      const { overflowResync } = setup({
        sessionId: "s1",
        lastReceived: Date.now() - 60_000,
        daemonRecent: true,
        rebindOutput,
      });
      await vi.advanceTimersByTimeAsync(27_000);
      expect(rebindOutput).toHaveBeenCalledTimes(1);
      expect(overflowResync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat a genuinely quiet session as starved", async () => {
    vi.useFakeTimers();
    try {
      const rebindOutput = vi.fn().mockResolvedValue(undefined);
      // daemon 最近 60s 无产出（旧历史不算饿）。
      setup({ sessionId: "s1", lastReceived: 0, daemonLast: Date.now() - 60_000, rebindOutput });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(rebindOutput).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing while output flows normally", async () => {
    vi.useFakeTimers();
    try {
      const rebindOutput = vi.fn().mockResolvedValue(undefined);
      setup({ sessionId: "s1", lastReceived: Date.now() - 1_000, daemonLast: Date.now() - 1_000, rebindOutput });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(rebindOutput).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
