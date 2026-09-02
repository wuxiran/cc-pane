import { describe, expect, it, vi } from "vitest";

import { createTerminalHiddenWriteBuffer } from "./terminalHiddenWriteBuffer";
import * as terminalSessionBinding from "./terminalSessionBinding";

const { createHiddenWriteFlusher } = terminalSessionBinding;

describe("terminalSessionBinding hidden-output flush", () => {
  it("returns a promise that settles only after xterm consumes the pending output", async () => {
    const buffer = createTerminalHiddenWriteBuffer({ isVisible: () => false });
    buffer.push("hidden backlog");

    let finishWrite!: () => void;
    const syncTrackedBufferType = vi.fn();
    const writeTerminalData = vi.fn((_: string, onWritten?: () => void) => (
      new Promise<void>((resolve) => {
        finishWrite = () => {
          onWritten?.();
          resolve();
        };
      })
    ));
    const flush = createHiddenWriteFlusher({
      hiddenWriteBufferRef: { current: buffer },
      resyncActiveRef: { current: false },
      overflowResyncRef: { current: null },
      writeTerminalData,
      syncTrackedBufferType,
      debugLog: vi.fn(),
    });

    const completion = flush("view.visible-edge");
    let settled = false;
    void completion.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(syncTrackedBufferType).not.toHaveBeenCalled();

    finishWrite();
    await completion;

    expect(settled).toBe(true);
    expect(syncTrackedBufferType).toHaveBeenCalledWith("output.hidden.flush");
  });

  it("waits for hidden output to flush before scheduling the visible-edge refit", async () => {
    let finishFlush!: () => void;
    const flushHiddenWrites = vi.fn(() => new Promise<"ready">((resolve) => {
      finishFlush = () => resolve("ready");
    }));
    const scheduleRefit = vi.fn();

    const completion = terminalSessionBinding.restoreVisibleTerminalView({
      flushHiddenWrites,
      isRenderVisible: () => true,
      scheduleRefit,
    });

    await Promise.resolve();
    expect(scheduleRefit).not.toHaveBeenCalled();

    finishFlush();
    await completion;

    expect(scheduleRefit).toHaveBeenCalledOnce();
  });

  it("skips refit when the view becomes hidden again during the flush", async () => {
    let visible = true;
    let finishFlush!: () => void;
    const flushHiddenWrites = vi.fn(() => new Promise<"ready">((resolve) => {
      finishFlush = () => resolve("ready");
    }));
    const scheduleRefit = vi.fn();

    const completion = terminalSessionBinding.restoreVisibleTerminalView({
      flushHiddenWrites,
      isRenderVisible: () => visible,
      scheduleRefit,
    });
    visible = false;
    finishFlush();
    await completion;

    expect(scheduleRefit).not.toHaveBeenCalled();
  });

  it("makes a repeated visible edge wait for the hidden write already in flight", async () => {
    const buffer = createTerminalHiddenWriteBuffer({ isVisible: () => false });
    buffer.push("hidden backlog");

    let finishWrite!: () => void;
    const writeTerminalData = vi.fn(() => new Promise<void>((resolve) => {
      finishWrite = resolve;
    }));
    const flushHiddenWrites = createHiddenWriteFlusher({
      hiddenWriteBufferRef: { current: buffer },
      resyncActiveRef: { current: false },
      overflowResyncRef: { current: null },
      writeTerminalData,
      syncTrackedBufferType: vi.fn(),
      debugLog: vi.fn(),
    });
    const scheduleRefit = vi.fn();
    const restore = () => terminalSessionBinding.restoreVisibleTerminalView({
      flushHiddenWrites,
      isRenderVisible: () => true,
      scheduleRefit,
    });

    const firstRestore = restore();
    const secondRestore = restore();
    await Promise.resolve();

    expect(writeTerminalData).toHaveBeenCalledOnce();
    expect(scheduleRefit).not.toHaveBeenCalled();

    finishWrite();
    await Promise.all([firstRestore, secondRestore]);

    expect(scheduleRefit).toHaveBeenCalledTimes(2);
  });

  it("lets overflow resync own the final refit and waits for it to settle", async () => {
    const buffer = createTerminalHiddenWriteBuffer({
      isVisible: () => false,
      maxPendingChars: 4,
    });
    buffer.push("overflow");

    let finishResync!: () => void;
    const overflowResync = vi.fn(() => new Promise<boolean>((resolve) => {
      finishResync = () => resolve(true);
    }));
    const flushHiddenWrites = createHiddenWriteFlusher({
      hiddenWriteBufferRef: { current: buffer },
      resyncActiveRef: { current: false },
      overflowResyncRef: { current: overflowResync },
      writeTerminalData: vi.fn(),
      syncTrackedBufferType: vi.fn(),
      debugLog: vi.fn(),
    });
    const scheduleRefit = vi.fn();

    const completion = terminalSessionBinding.restoreVisibleTerminalView({
      flushHiddenWrites,
      isRenderVisible: () => true,
      scheduleRefit,
    });
    await Promise.resolve();

    expect(overflowResync).toHaveBeenCalledOnce();
    expect(scheduleRefit).not.toHaveBeenCalled();

    finishResync();
    await completion;

    expect(scheduleRefit).not.toHaveBeenCalled();
  });
});
