// 内存契约（docs/107 P1 验收）：30 个挂载终端、25 个隐藏 →
//   隐藏且仍持有 xterm 实例的 ≤ 6（parkedTerminalLimit 默认值），
//   隐藏且持有 WebGL context 的 ≤ 6（MAX_HIDDEN_TERMINAL_WEBGL_CONTEXTS），总 context ≤ 8。
// 纯逻辑：只驱动注册表与预算池，不构造 xterm。
import { describe, expect, it } from "vitest";
import { createTerminalParkingRegistry } from "./terminalParkingRegistry";
import {
  MAX_HIDDEN_TERMINAL_WEBGL_CONTEXTS,
  MAX_TERMINAL_WEBGL_CONTEXTS,
  createTerminalWebglBudget,
} from "./terminalWebglBudget";
import { DEFAULT_PARKED_TERMINAL_LIMIT } from "./terminalParkingSettings";

interface FakeTerminal {
  owner: object;
  visible: boolean;
  xtermAlive: boolean;
}

describe("停泊内存契约：30 挂载 / 25 隐藏", () => {
  it("≤6 个隐藏 xterm 实例存活，≤6 个隐藏 WebGL context，总 context ≤8", () => {
    let clock = 0;
    const registry = createTerminalParkingRegistry({
      limit: DEFAULT_PARKED_TERMINAL_LIMIT,
      now: () => clock,
    });
    const budget = createTerminalWebglBudget(MAX_TERMINAL_WEBGL_CONTEXTS, {
      hiddenLimit: MAX_HIDDEN_TERMINAL_WEBGL_CONTEXTS,
      now: () => clock,
    });
    const terminals: FakeTerminal[] = Array.from({ length: 30 }, (_, i) => ({
      owner: { i },
      visible: true,
      xtermAlive: true,
    }));

    // 全部挂载、全部可见时各自申请 WebGL（最多 8 个拿到，其余等待——与真实 controller 一致）。
    for (const t of terminals) {
      clock += 1;
      budget.acquire(t.owner, () => {}, () => t.visible, () => {});
    }
    expect(budget.count()).toBeLessThanOrEqual(MAX_TERMINAL_WEBGL_CONTEXTS);

    // 25 个依次隐藏：进入注册表，park 回调 = dispose xterm + 归还 WebGL 租约。
    for (const t of terminals.slice(0, 25)) {
      clock += 1;
      t.visible = false;
      registry.notifyHidden(t.owner, () => {
        t.xtermAlive = false;
        budget.release(t.owner);
        return true;
      });
      budget.sweep();
    }

    const hiddenAlive = terminals.filter((t) => !t.visible && t.xtermAlive);
    const visibleAlive = terminals.filter((t) => t.visible && t.xtermAlive);
    expect(hiddenAlive.length).toBeLessThanOrEqual(DEFAULT_PARKED_TERMINAL_LIMIT);
    expect(visibleAlive).toHaveLength(5);
    expect(registry.hiddenCount()).toBe(hiddenAlive.length);
    expect(budget.hiddenCount()).toBeLessThanOrEqual(MAX_HIDDEN_TERMINAL_WEBGL_CONTEXTS);
    expect(budget.count()).toBeLessThanOrEqual(MAX_TERMINAL_WEBGL_CONTEXTS);

    // 逐出顺序是 LRU：最早隐藏的 19 个被停泊，最后隐藏的 6 个仍活着。
    const survivors = terminals.slice(0, 25).filter((t) => t.xtermAlive).map((t) => terminals.indexOf(t));
    expect(survivors).toEqual([19, 20, 21, 22, 23, 24]);
  });
});
