import { describe, expect, it, vi } from "vitest";
import { createTerminalWriteFlowControl } from "./terminalWriteFlowControl";

describe("createTerminalWriteFlowControl", () => {
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

    expect(target.write.mock.calls.length).toBeLessThan(writes.length);
    expect(target.write).toHaveBeenCalledTimes(4);
    completeImmediately = true;
    while (callbacks.length > 0) callbacks.shift()?.();
    await Promise.all(writes);
    expect(target.write).toHaveBeenCalledTimes(writes.length);
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

  it("reset clears blocked state and lets pending writers continue", async () => {
    const callbacks: Array<() => void> = [];
    const target = {
      write: vi.fn((_data: string, callback?: () => void) => {
        if (callback) callbacks.push(callback);
      }),
    };

    const flow = createTerminalWriteFlowControl(target, {
      enabled: true,
      bytesThreshold: 0,
      highWatermark: 1,
      lowWatermark: 0,
    });

    const first = flow.write("first");
    await Promise.resolve();
    expect(target.write).toHaveBeenCalledTimes(1);

    const blockedWrite = flow.write("second");
    await Promise.resolve();
    expect(target.write).toHaveBeenCalledTimes(1);

    flow.reset();
    await Promise.resolve();
    expect(target.write).toHaveBeenCalledTimes(2);

    callbacks.shift()?.();
    await first;
    callbacks.shift()?.();
    await blockedWrite;
  });
});
