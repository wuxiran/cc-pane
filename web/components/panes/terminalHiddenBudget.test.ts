import { beforeEach, describe, expect, it } from "vitest";
import {
  HIDDEN_BACKLOG_GLOBAL_BUDGET_CHARS,
  HIDDEN_BACKLOG_MAX_PER_TERMINAL_CHARS,
  HIDDEN_BACKLOG_MIN_PER_TERMINAL_CHARS,
  hiddenBacklogQuotaChars,
  hiddenTerminalCount,
  registerHiddenTerminal,
  unregisterHiddenTerminal,
  _resetHiddenBudgetForTest,
} from "./terminalHiddenBudget";

describe("terminalHiddenBudget", () => {
  beforeEach(() => {
    _resetHiddenBudgetForTest();
  });

  it("单个后台终端拿满旧的固定配额（不回退体验）", () => {
    expect(hiddenBacklogQuotaChars(1)).toBe(HIDDEN_BACKLOG_MAX_PER_TERMINAL_CHARS);
    // 零个也不该算出 Infinity 或除零
    expect(hiddenBacklogQuotaChars(0)).toBe(HIDDEN_BACKLOG_MAX_PER_TERMINAL_CHARS);
  });

  it("多终端时配额随数量收缩，总量封顶", () => {
    // 旧行为：18 × 512KB = 9MB 上限。新行为总量恒定。
    for (const count of [2, 4, 8, 18, 40]) {
      const quota = hiddenBacklogQuotaChars(count);
      expect(quota * count).toBeLessThanOrEqual(
        Math.max(HIDDEN_BACKLOG_GLOBAL_BUDGET_CHARS, HIDDEN_BACKLOG_MIN_PER_TERMINAL_CHARS * count),
      );
      expect(quota).toBeLessThanOrEqual(HIDDEN_BACKLOG_MAX_PER_TERMINAL_CHARS);
    }
    // 收缩是单调的
    expect(hiddenBacklogQuotaChars(8)).toBeLessThan(hiddenBacklogQuotaChars(2));
  });

  it("配额有下限：够放下一整屏 TUI 重绘", () => {
    // 否则常规重绘就能顶爆缓冲，切回来永远在走 snapshot 重放
    expect(hiddenBacklogQuotaChars(1000)).toBe(HIDDEN_BACKLOG_MIN_PER_TERMINAL_CHARS);
  });

  it("登记幂等，注销后分母回落", () => {
    const owners = Array.from({ length: 8 }, () => ({}));
    for (const owner of owners) registerHiddenTerminal(owner);
    registerHiddenTerminal(owners[0]); // 幂等
    expect(hiddenTerminalCount()).toBe(8);

    // 注：2~4 个终端时 2MB/n 仍高于单份上限 512KB，被上限夹住看不出差别；
    // 要观察收缩必须取分母足够大的样本。
    const crowdedQuota = hiddenBacklogQuotaChars();
    for (const owner of owners.slice(0, 6)) unregisterHiddenTerminal(owner);
    expect(hiddenTerminalCount()).toBe(2);
    // 分母回落后其余终端的额度必须回升——否则解绑过的缓冲会永久压小别人
    expect(hiddenBacklogQuotaChars()).toBeGreaterThan(crowdedQuota);
  });

  it("注销未登记的对象是无害的", () => {
    expect(() => unregisterHiddenTerminal({})).not.toThrow();
    expect(hiddenTerminalCount()).toBe(0);
  });

  it("同一会话的多个视图各占一份配额", () => {
    // 主标签 + 星标镜像持有各自独立的缓冲，内存也是各算各的，
    // 所以分母按缓冲个数而不是 sessionId 计。
    const primary = {};
    const mirror = {};
    registerHiddenTerminal(primary);
    registerHiddenTerminal(mirror);
    expect(hiddenTerminalCount()).toBe(2);
  });
});
