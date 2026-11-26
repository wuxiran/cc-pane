import { describe, expect, it, vi } from "vitest";
import { createTerminalWriteFlowControl } from "./terminalWriteFlowControl";

describe("createTerminalWriteFlowControl", () => {
  it("tracks waiting and in-flight characters without retaining output in diagnostics", async () => {
    let now = 100;
    const callbacks: Array<() => void> = [];
    const flow = createTerminalWriteFlowControl({ write: (_data, callback) => { callbacks.push(callback!); } },
      { bytesThreshold: 1, highWatermark: 1, lowWatermark: 0, now: () => now });
    const first = flow.write("中文");
    const second = flow.write("private-prompt");
    now += 80;
    expect(flow.getStats()).toMatchObject({ queuedChars: 14, inFlightChars: 2, queuedWrites: 1, oldestWaitMs: 80, writeCalls: 2 });
    expect(JSON.stringify(flow.getStats())).not.toContain("private-prompt");
    callbacks.shift()!(); await first;
    expect(flow.getStats()).toMatchObject({ queuedChars: 0, inFlightChars: 14, callbackMaxMs: 80 });
    now += 20; callbacks.shift()!(); await second;
    expect(flow.getStats()).toMatchObject({ queuedChars: 0, inFlightChars: 0, callbackMaxMs: 100, receivedChars: 16 });
  });

  it("removes failed target writes from in-flight diagnostics", async () => {
    const flow = createTerminalWriteFlowControl({ write: () => { throw new Error("closed"); } });
    await expect(flow.write("test")).rejects.toThrow("closed");
    expect(flow.getStats()).toMatchObject({ queuedChars: 0, inFlightChars: 0, inFlightWrites: 0, failedWrites: 1 });
  });
  it("applies backpressure with the default watermarks after a bounded burst", async () => {
    const callbacks: Array<() => void> = [];
    let completeImmediately = false;
    const target = {
      write: vi.fn((_data: string, callback?: () => void) => {
        if (!callback) return;
        if (completeImmediately) callback();
        else callbacks.push(callback);
      }),
    };

    const flow = createTerminalWriteFlowControl(target);
    const writes = Array.from(
      { length: 10 },
      (_, index) => flow.write(`${index}`.padEnd(16 * 1024, "x")),
    );

    expect(target.write).toHaveBeenCalledTimes(4);
    completeImmediately = true;
    while (callbacks.length > 0) callbacks.shift()?.();
    await Promise.all(writes);
    expect(target.write).toHaveBeenCalledTimes(writes.length);
  });

  it("splits a large replay into bounded xterm writes while preserving one promise", async () => {
    const callbacks: Array<() => void> = [];
    const chunks: string[] = [];
    const flow = createTerminalWriteFlowControl({
      write: (data, callback) => { chunks.push(data); if (callback) callbacks.push(callback); },
    });
    const pending = flow.write("x".repeat(40 * 1024));
    expect(chunks[0]).toHaveLength(16 * 1024);
    callbacks.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chunks[1]).toHaveLength(16 * 1024);
    callbacks.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chunks[2]).toHaveLength(8 * 1024);
    callbacks.shift()?.();
    await pending;
    expect(flow.getStats()).toMatchObject({ queuedChars: 0, inFlightChars: 0, failedWrites: 0 });
  });

  it("writes immediately when flow control is disabled", async () => {
    const callbacks: Array<() => void> = [];
    const target = {
      write: vi.fn((data: string, callback?: () => void) => {
        expect(data).toBe("hello");
        if (callback) callbacks.push(callback);
      }),
    };

    const flow = createTerminalWriteFlowControl(target, {
      enabled: false,
      bytesThreshold: 0,
    });

    const onWritten = vi.fn();
    const pending = flow.write("hello", onWritten);
    expect(target.write).toHaveBeenCalledTimes(1);
    expect(onWritten).not.toHaveBeenCalled();

    callbacks.shift()?.();
    await pending;
    expect(onWritten).toHaveBeenCalledTimes(1);
  });

  it("blocks later writes after the high watermark and resumes after callbacks drain", async () => {
    const callbacks: Array<() => void> = [];
    const target = {
      write: vi.fn((_data: string, callback?: () => void) => {
        if (callback) callbacks.push(callback);
      }),
    };

    const flow = createTerminalWriteFlowControl(target, {
      enabled: true,
      bytesThreshold: 0,
      highWatermark: 2,
      lowWatermark: 0,
    });

    const first = flow.write("first");
    const second = flow.write("second");
    await Promise.resolve();
    expect(target.write).toHaveBeenCalledTimes(2);

    const third = flow.write("third");
    await Promise.resolve();
    expect(target.write).toHaveBeenCalledTimes(2);

    callbacks.shift()?.();
    await first;
    await Promise.resolve();
    expect(target.write).toHaveBeenCalledTimes(2);

    callbacks.shift()?.();
    await second;
    await Promise.resolve();
    expect(target.write).toHaveBeenCalledTimes(3);

    callbacks.shift()?.();
    await third;
  });

  it("disposal rejects every outstanding write and is terminal", async () => {
    const callbacks: Array<() => void> = [];
    const target = { write: vi.fn((_data: string, callback?: () => void) => callbacks.push(callback!)) };
    const flow = createTerminalWriteFlowControl(target, { bytesThreshold: 1, highWatermark: 1 });
    const first = flow.write("first").catch(error => error);
    const queued = flow.write("queued").catch(error => error);
    flow.dispose("unmounted");
    expect(await first).toMatchObject({ name: "AbortError", message: "unmounted" });
    expect(await queued).toMatchObject({ name: "AbortError" });
    callbacks[0](); callbacks[0]();
    await expect(flow.write("new")).rejects.toThrow("unmounted");
    expect(target.write).toHaveBeenCalledTimes(1);
    expect(flow.getStats()).toMatchObject({ queuedChars: 0, inFlightChars: 0, pendingCallbacks: 0 });
  });

  it("reports a stalled parser once without unlocking or replaying old input", async () => {
    vi.useFakeTimers();
    try {
      const onStall = vi.fn();
      const flow = createTerminalWriteFlowControl({ write: vi.fn() }, { onStall });
      const result = flow.write("small write below the credit threshold").catch(error => error);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await result).toBeInstanceOf(Error);
      expect(onStall).toHaveBeenCalledTimes(1);
      await expect(flow.write("new")).rejects.toThrow("no progress");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onStall).toHaveBeenCalledTimes(1);
      expect(flow.getStats()).toMatchObject({ inFlightWrites: 0, queuedChars: 0 });
    } finally { vi.useRealTimers(); }
  });

  it("settles in-flight writes on disposal and ignores their late tails", async () => {
    vi.useFakeTimers();
    try {
      const callbacks: Array<() => void> = [];
      const target = { write: vi.fn((_data: string, callback?: () => void) => callbacks.push(callback!)) };
      const flow = createTerminalWriteFlowControl(target);
      let result = "pending";
      const done = flow.write("x".repeat(20_000)).then(() => { result = "ok"; }, () => { result = "cancelled"; });
      flow.dispose();
      await Promise.resolve();
      expect(result).toBe("cancelled");
      callbacks[0]();
      await vi.runAllTimersAsync();
      expect(target.write).toHaveBeenCalledTimes(1);
      await expect(flow.write("after dispose")).rejects.toThrow();
      expect(flow.getStats()).toMatchObject({ queuedChars: 0, inFlightChars: 0, inFlightWrites: 0 });
      await done;
    } finally { vi.useRealTimers(); }
  });

  it("keeps a large write's tail ahead of subsequently queued output", async () => {
    vi.useFakeTimers();
    try {
      const callbacks: Array<() => void> = [];
      const chunks: string[] = [];
      const flow = createTerminalWriteFlowControl({ write: (data, callback) => { chunks.push(data); callbacks.push(callback!); } });
      const first = flow.write("x".repeat(16_384) + "TAIL");
      const next = flow.write("NEW");
      callbacks.shift()!();
      await vi.advanceTimersByTimeAsync(20);
      while (callbacks.length) callbacks.shift()!();
      await Promise.all([first, next]);
      expect(chunks.join("")).toBe("x".repeat(16_384) + "TAILNEW");
    } finally { vi.useRealTimers(); }
  });
});
