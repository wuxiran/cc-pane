import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WEBGL_CONTEXT_LOSS_RETRY_DELAY_MS,
  WEBGL_CONTEXT_LOSS_WINDOW_MS,
  createTerminalWebglContextLossRetry,
} from "./terminalWebglContextLossRetry";

describe("createTerminalWebglContextLossRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("60 s 内前三次丢失安排重试（1s/2s/4s 退避），第四次钉 DOM", () => {
    const retry = vi.fn();
    const guard = createTerminalWebglContextLossRetry(retry, { now: () => Date.now() });

    expect(guard.recordLoss()).toBe(true);
    vi.advanceTimersByTime(WEBGL_CONTEXT_LOSS_RETRY_DELAY_MS - 1);
    expect(retry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledTimes(1);

    expect(guard.recordLoss()).toBe(true);
    vi.advanceTimersByTime(WEBGL_CONTEXT_LOSS_RETRY_DELAY_MS * 2);
    expect(retry).toHaveBeenCalledTimes(2);

    expect(guard.recordLoss()).toBe(true);
    vi.advanceTimersByTime(WEBGL_CONTEXT_LOSS_RETRY_DELAY_MS * 4);
    expect(retry).toHaveBeenCalledTimes(3);

    expect(guard.recordLoss()).toBe(false);
    expect(guard.isPinned()).toBe(true);
    vi.advanceTimersByTime(WEBGL_CONTEXT_LOSS_RETRY_DELAY_MS * 16);
    expect(retry).toHaveBeenCalledTimes(3);
  });

  it("窗口滑过后计数清零，又能重试", () => {
    const retry = vi.fn();
    const guard = createTerminalWebglContextLossRetry(retry, { now: () => Date.now() });
    for (let i = 0; i < 3; i += 1) guard.recordLoss();
    expect(guard.recordLoss()).toBe(false);
    vi.advanceTimersByTime(WEBGL_CONTEXT_LOSS_WINDOW_MS + 1);
    expect(guard.lossesInWindow()).toBe(0);
    expect(guard.recordLoss()).toBe(true);
    expect(guard.isPinned()).toBe(false);
  });

  it("连续丢失覆盖未触发的重试（只保留最后一次计时）", () => {
    const retry = vi.fn();
    const guard = createTerminalWebglContextLossRetry(retry, { now: () => Date.now() });
    guard.recordLoss();
    vi.advanceTimersByTime(500);
    guard.recordLoss();
    vi.advanceTimersByTime(WEBGL_CONTEXT_LOSS_RETRY_DELAY_MS * 2 - 1);
    expect(retry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("dispose 后不再重试也不再记账", () => {
    const retry = vi.fn();
    const guard = createTerminalWebglContextLossRetry(retry);
    guard.recordLoss();
    guard.dispose();
    vi.advanceTimersByTime(WEBGL_CONTEXT_LOSS_RETRY_DELAY_MS * 8);
    expect(retry).not.toHaveBeenCalled();
    expect(guard.recordLoss()).toBe(false);
  });
});
