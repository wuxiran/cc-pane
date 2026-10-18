import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalInputActivityStore } from "@/stores/useTerminalInputActivityStore";
import { createTerminalBackgroundLifecycle } from "./terminalBackgroundLifecycle";
import type { HibernatedTerminalState } from "./terminalHibernation";
import { createParkedTerminalState, parkTerminal, type ParkTerminalContext } from "./terminalParking";


function createContext(overrides: Partial<ParkTerminalContext> = {}): ParkTerminalContext {
  return {
    terminalInstanceRef: { current: { cols: 120, rows: 40 } },
    currentSessionIdRef: { current: "s1" },
    hibernatedStateRef: { current: null as HibernatedTerminalState | null },
    isReconnectingRef: { current: false },
    isDisconnectedRef: { current: false },
    debugLog: vi.fn(),
    bumpInstanceEpoch: vi.fn(),
    reason: "park-timer",
    ...overrides,
  };
}

beforeEach(() => {
  useTerminalInputActivityStore.setState({ entries: {} } as never);
});

describe("createParkedTerminalState", () => {
  it("空基底 + 立即作废：唤醒必走 snapshot，几何保留", () => {
    const state = createParkedTerminalState({ sessionId: "s1", cols: 100, rows: 30 });
    expect(state.wakeData()).toBeNull();
    expect(state.didOverflow()).toBe(true);
    expect(state.cols).toBe(100);
    expect(state.rows).toBe(30);
    expect(state.pendingChars()).toBe(0);
    // 停泊期间不收集输出（Tauri 隐藏会话本就收不到字节）
    state.appendRendered("ignored");
    expect(state.wakeData()).toBeNull();
    state.recordExit(3);
    expect(state.exitCode()).toBe(3);
  });
});

describe("parkTerminal", () => {
  it("停泊：交接容器 + epoch 自增，返回 true", () => {
    const ctx = createContext();
    expect(parkTerminal(ctx)).toBe(true);
    expect(ctx.hibernatedStateRef.current).not.toBeNull();
    expect(ctx.hibernatedStateRef.current?.sessionId).toBe("s1");
    expect(ctx.hibernatedStateRef.current?.cols).toBe(120);
    expect(ctx.hibernatedStateRef.current?.rows).toBe(40);
    expect(ctx.hibernatedStateRef.current?.wakeData()).toBeNull();
    expect(ctx.bumpInstanceEpoch).toHaveBeenCalledTimes(1);
    expect(ctx.debugLog).toHaveBeenCalledWith("park.begin", expect.objectContaining({
      parkSessionId: "s1", reason: "park-timer", cols: 120, rows: 40,
    }));
  });

  it("已休眠/已停泊：幂等返回 true，不再 bump", () => {
    const ctx = createContext();
    parkTerminal(ctx);
    expect(parkTerminal(ctx)).toBe(true);
    expect(ctx.bumpInstanceEpoch).toHaveBeenCalledTimes(1);
  });

  it("无实例 / 无会话 / 重连中 / 已断开：返回 false 且不交接", () => {
    for (const ctx of [
      createContext({ terminalInstanceRef: { current: null } }),
      createContext({ currentSessionIdRef: { current: null } }),
      createContext({ isReconnectingRef: { current: true } }),
      createContext({ isDisconnectedRef: { current: true } }),
    ]) {
      expect(parkTerminal(ctx)).toBe(false);
      expect(ctx.hibernatedStateRef.current).toBeNull();
      expect(ctx.bumpInstanceEpoch).not.toHaveBeenCalled();
    }
  });

  it("忙碌段近期输入（草稿）豁免：返回 false，留给下轮；waitingInput 段不豁免", () => {
    useTerminalInputActivityStore.getState().recordInput("s1", "busy", Date.now());
    const blocked = createContext();
    expect(parkTerminal(blocked)).toBe(false);
    expect(blocked.hibernatedStateRef.current).toBeNull();
    expect(blocked.debugLog).toHaveBeenCalledWith("park.skipped.input-active", expect.anything());

    useTerminalInputActivityStore.getState().recordInput("s1", "waitingInput", Date.now());
    const allowed = createContext();
    expect(parkTerminal(allowed)).toBe(true);
  });
});

afterEach(() => vi.useRealTimers());

it("parks after the real input guard expires without another visibility change", () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const ctx = createContext();
  useTerminalInputActivityStore.getState().recordInput("s1", "idle");
  const lifecycle = createTerminalBackgroundLifecycle({
    onPark: () => parkTerminal(ctx), onTier1: vi.fn(), onTier1Restore: vi.fn(),
    onTier2: vi.fn(), onTier2Restore: vi.fn(),
  });
  lifecycle.notifyVisibility(false);
  vi.advanceTimersByTime(30_000);
  expect(ctx.hibernatedStateRef.current).toBeNull();
  vi.advanceTimersByTime(30_000);
  expect(ctx.hibernatedStateRef.current).not.toBeNull();
  expect(ctx.bumpInstanceEpoch).toHaveBeenCalledTimes(1);
  lifecycle.dispose();
});
