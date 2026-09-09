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

  it("dispose 拒绝排队中的写入（否则卸载后 Promise 永不 settle）", async () => {
    const target = {
      write: vi.fn((_data: string, _callback?: () => void) => {
        // 从不调 callback：模拟 xterm 卡住 / 视图卸载途中
      }),
    };

    const flow = createTerminalWriteFlowControl(target, {
      enabled: true,
      bytesThreshold: 0,
      highWatermark: 1,
      lowWatermark: 0,
    });

    flow.write("in-flight");
    const queued = flow.write("queued");
    await Promise.resolve();
    expect(flow.queueLength()).toBe(1);

    // 这些 Promise 的等待方（terminalOutputHandler）在 catch 里归还流控信用；
    // 不 reject 的话信用永远还不回去，上游窗口被永久缩小一截。
    flow.dispose("terminal view unmounted");
    await expect(queued).rejects.toThrow("terminal view unmounted");
    expect(flow.queueLength()).toBe(0);
  });

  it("dispose 后可继续写入（reset 语义不被破坏）", async () => {
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

    flow.write("first");
    const blocked = flow.write("blocked");
    await Promise.resolve();
    flow.dispose();
    await expect(blocked).rejects.toThrow();

    // 闸门已复位：新的写入立刻通过，而不是卡在 dispose 前的 blocked 状态
    const after = flow.write("after");
    await Promise.resolve();
    expect(target.write).toHaveBeenCalledTimes(2);
    callbacks.pop()?.();
    await after;
  });
});
