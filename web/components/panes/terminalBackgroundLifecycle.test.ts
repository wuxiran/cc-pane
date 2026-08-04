import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_TIER1_DELAY_MS,
  BACKGROUND_TIER2_DELAY_MS,
  createTerminalBackgroundLifecycle,
} from "./terminalBackgroundLifecycle";

describe("createTerminalBackgroundLifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function createHooks() {
    return {
      onTier1: vi.fn(),
      onTier1Restore: vi.fn(),
      onTier2: vi.fn(),
      onTier2Restore: vi.fn(),
    };
  }

  it("隐藏满两档延迟依次触发 Tier1 / Tier2", () => {
    const hooks = createHooks();
    const lifecycle = createTerminalBackgroundLifecycle(hooks);

    lifecycle.notifyVisibility(false);
    vi.advanceTimersByTime(BACKGROUND_TIER1_DELAY_MS);
    expect(hooks.onTier1).toHaveBeenCalledTimes(1);
    expect(hooks.onTier2).not.toHaveBeenCalled();

    vi.advanceTimersByTime(BACKGROUND_TIER2_DELAY_MS - BACKGROUND_TIER1_DELAY_MS);
    expect(hooks.onTier2).toHaveBeenCalledTimes(1);
  });

  it("重复汇报同一可见性完全幂等（每次 render 都会被调用）", () => {
    const hooks = createHooks();
    const lifecycle = createTerminalBackgroundLifecycle(hooks);

    lifecycle.notifyVisibility(false);
    vi.advanceTimersByTime(BACKGROUND_TIER1_DELAY_MS - 1000);
    // 隐藏期间的重复汇报不得重置定时器
    lifecycle.notifyVisibility(false);
    vi.advanceTimersByTime(1000);
    expect(hooks.onTier1).toHaveBeenCalledTimes(1);

    lifecycle.notifyVisibility(true);
    lifecycle.notifyVisibility(true);
    expect(hooks.onTier1Restore).toHaveBeenCalledTimes(1);
  });

  it("降档前变可见：取消定时器，不触发任何回调", () => {
    const hooks = createHooks();
    const lifecycle = createTerminalBackgroundLifecycle(hooks);

    lifecycle.notifyVisibility(false);
    vi.advanceTimersByTime(BACKGROUND_TIER1_DELAY_MS - 1);
    lifecycle.notifyVisibility(true);
    vi.advanceTimersByTime(BACKGROUND_TIER2_DELAY_MS * 2);

    expect(hooks.onTier1).not.toHaveBeenCalled();
    expect(hooks.onTier2).not.toHaveBeenCalled();
    expect(hooks.onTier1Restore).not.toHaveBeenCalled();
    expect(hooks.onTier2Restore).not.toHaveBeenCalled();
  });

  it("Tier2 已触发时恢复只走唤醒（Tier1 restore 不再有意义）", () => {
    const hooks = createHooks();
    const lifecycle = createTerminalBackgroundLifecycle(hooks);

    lifecycle.notifyVisibility(false);
    vi.advanceTimersByTime(BACKGROUND_TIER2_DELAY_MS);
    expect(hooks.onTier2).toHaveBeenCalledTimes(1);

    lifecycle.notifyVisibility(true);
    expect(hooks.onTier2Restore).toHaveBeenCalledTimes(1);
    expect(hooks.onTier1Restore).not.toHaveBeenCalled();
  });

  it("再次隐藏重新计时（完整第二轮）", () => {
    const hooks = createHooks();
    const lifecycle = createTerminalBackgroundLifecycle(hooks);

    lifecycle.notifyVisibility(false);
    vi.advanceTimersByTime(BACKGROUND_TIER1_DELAY_MS);
    lifecycle.notifyVisibility(true);

    lifecycle.notifyVisibility(false);
    vi.advanceTimersByTime(BACKGROUND_TIER1_DELAY_MS);
    expect(hooks.onTier1).toHaveBeenCalledTimes(2);
  });

  it("dispose 后不再触发", () => {
    const hooks = createHooks();
    const lifecycle = createTerminalBackgroundLifecycle(hooks);

    lifecycle.notifyVisibility(false);
    lifecycle.dispose();
    vi.advanceTimersByTime(BACKGROUND_TIER2_DELAY_MS * 2);

    expect(hooks.onTier1).not.toHaveBeenCalled();
    expect(hooks.onTier2).not.toHaveBeenCalled();
  });
});
