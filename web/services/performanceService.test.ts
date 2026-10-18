import { afterEach, describe, expect, it, vi } from "vitest";
const runtime = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("./runtime", () => ({ invokeIfTauri: runtime.invoke, isTauriRuntime: runtime.isTauri }));
import { startPerformanceSampling } from "./performanceService";
import { registerTerminalPerformanceSource } from "./performanceMetrics";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });
describe("performance sampler lifecycle", () => {
  it("keeps frontend-only flow diagnostics out of the strict recorder DTO", () => {
    runtime.invoke.mockResolvedValue(undefined);
    const remove = registerTerminalPerformanceSource(() => ({
      sessionId: "input-probe", visible: true, renderer: "webgl",
      queuedChars: 0, inFlightChars: 0, queuedWrites: 0, receivedChars: 1,
      writeCalls: 1, failedWrites: 0, oldestWaitMs: 0, callbackMaxMs: 2,
      blocked: false, pendingCallbacks: 0, hiddenChars: 0, resyncActive: false,
      contextLosses: 0, atlasClears: 0, scrollbackLines: 20,
    }));
    const stop = startPerformanceSampling();
    try {
      const snapshot = runtime.invoke.mock.calls[0][1].snapshot;
      expect(snapshot.terminals[0]).toMatchObject({ sessionId: "input-probe", callbackMaxMs: 2 });
      expect(snapshot.terminals[0]).not.toHaveProperty("blocked");
      expect(snapshot.terminals[0]).not.toHaveProperty("pendingCallbacks");
    } finally { stop(); remove(); }
  });
  it("recovers after a transient sampling failure instead of staying in flight forever", async () => {
    vi.useFakeTimers(); runtime.invoke.mockResolvedValue(undefined);
    const query = vi.spyOn(document, "querySelectorAll").mockImplementationOnce(() => { throw new Error("temporary DOM failure"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = startPerformanceSampling();
    try {
      expect(runtime.invoke).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(runtime.invoke).toHaveBeenCalledTimes(1);
    } finally { stop(); query.mockRestore(); warn.mockRestore(); }
  });
  it("does not accumulate IPC calls while a report is stalled and stops timers on cleanup", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    runtime.invoke.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const stop = startPerformanceSampling();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runtime.invoke).toHaveBeenCalledTimes(1);
    expect(runtime.invoke.mock.calls[0][1].snapshot).toMatchObject({ terminalCount: 0, terminals: [], longTaskSupported: false });
    finish(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(runtime.invoke).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runtime.invoke).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not schedule desktop diagnostics in web mode", () => {
    vi.useFakeTimers(); runtime.isTauri.mockReturnValueOnce(false);
    startPerformanceSampling()();
    expect(runtime.invoke).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps real visible lag but records long observation gaps separately", async () => {
    vi.useFakeTimers(); runtime.invoke.mockResolvedValue(undefined);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const stop = startPerformanceSampling();
    try {
      now = 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      now = 5_000;
      await vi.advanceTimersByTimeAsync(14_000);
      expect(runtime.invoke.mock.lastCall?.[1].snapshot).toMatchObject({ timerLagMs: 3_000, samplingGapMs: 0 });
      now += 3_600_000;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(runtime.invoke.mock.lastCall?.[1].snapshot).toMatchObject({ timerLagMs: 0, samplingGapMs: 3_600_000 });
    } finally { stop(); }
  });
  it("pauses the heartbeat while hidden and resets its baseline on visibility return", async () => {
    vi.useFakeTimers(); runtime.invoke.mockResolvedValue(undefined);
    let hidden = false;
    let now = 0;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const stop = startPerformanceSampling();
    try {
      expect(vi.getTimerCount()).toBe(2);
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      expect(vi.getTimerCount()).toBe(1);
      now = 3_600_000;
      await vi.advanceTimersByTimeAsync(60_000);
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(runtime.invoke.mock.lastCall?.[1].snapshot).toMatchObject({ timerLagMs: 0, samplingGapMs: 0 });
    } finally { stop(); }
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pageshow"));
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not erase visible lag when the window hides before the next report", async () => {
    vi.useFakeTimers(); runtime.invoke.mockResolvedValue(undefined);
    let hidden = false;
    let now = 0;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const stop = startPerformanceSampling();
    try {
      now = 5_000;
      await vi.advanceTimersByTimeAsync(1_000);
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(14_000);
      expect(runtime.invoke.mock.lastCall?.[1].snapshot).toMatchObject({ timingVersion: 2, timerLagMs: 4_000 });
    } finally { stop(); }
  });
  it("finishes an unobserved visible interval before processing a hide event", async () => {
    vi.useFakeTimers(); runtime.invoke.mockResolvedValue(undefined);
    let hidden = false;
    let now = 0;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const stop = startPerformanceSampling();
    try {
      now = 60_000; // No heartbeat ran during this interval.
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(15_000);
      expect(runtime.invoke.mock.lastCall?.[1].snapshot).toMatchObject({ timerLagMs: 0, samplingGapMs: 60_000 });
    } finally { stop(); }
  });
  it("retries timing observations after an IPC rejection", async () => {
    vi.useFakeTimers();
    runtime.invoke.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("IPC failed")).mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const stop = startPerformanceSampling();
    try {
      now = 5_000;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(runtime.invoke).toHaveBeenCalledTimes(3);
      expect(runtime.invoke.mock.calls[1][1].snapshot.timerLagMs).toBe(4_000);
      expect(runtime.invoke.mock.calls[2][1].snapshot.timerLagMs).toBe(4_000);
    } finally { stop(); }
  });
});
