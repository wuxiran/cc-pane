import { afterEach, describe, expect, it, vi } from "vitest";
const runtime = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("./runtime", () => ({ invokeIfTauri: runtime.invoke, isTauriRuntime: runtime.isTauri }));
import { startPerformanceSampling } from "./performanceService";

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
describe("performance sampler lifecycle", () => {
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
});
