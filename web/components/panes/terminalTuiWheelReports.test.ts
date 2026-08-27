import { describe, expect, it } from "vitest";

import {
  createTerminalTuiWheelDistanceState,
  isDiscreteTerminalTuiWheelEvent,
  normalizeTerminalTuiWheelMultiplier,
  resolveTerminalTuiWheelReportCount,
  TERMINAL_TUI_WHEEL_MULTIPLIER_DEFAULT,
  TERMINAL_TUI_WHEEL_MULTIPLIER_MAX,
  TERMINAL_TUI_WHEEL_MULTIPLIER_MIN,
  type TerminalTuiWheelEventInput,
} from "./terminalTuiWheelReports";

const CELL = { cellHeight: 16, rows: 24 };

/** 离散滚轮刻度：Chromium 在 Windows 上给的典型形态。 */
function wheelNotch(overrides: Partial<TerminalTuiWheelEventInput> = {}): TerminalTuiWheelEventInput {
  return { deltaY: 100, deltaMode: 0, wheelDeltaY: -120, timeStamp: 0, ...overrides };
}

/** 触控板：连续的小像素增量，没有传统 wheelDelta 刻度。 */
function trackpadTick(deltaY: number, timeStamp = 0): TerminalTuiWheelEventInput {
  return { deltaY, deltaMode: 0, timeStamp };
}

describe("terminalTuiWheelReports", () => {
  describe("输入分类", () => {
    it("按传统 wheelDelta 与像素增量识别离散滚轮刻度", () => {
      expect(isDiscreteTerminalTuiWheelEvent(wheelNotch())).toBe(true);
      // 行模式由浏览器直接给出行数，天然是离散的
      expect(isDiscreteTerminalTuiWheelEvent({ deltaY: 3, deltaMode: 1 })).toBe(true);
      // 触控板的小增量不是刻度
      expect(isDiscreteTerminalTuiWheelEvent(trackpadTick(6))).toBe(false);
    });
  });

  describe("离散滚轮", () => {
    it("一格滚轮至少发一个报告——这正是补偿 xterm 抑制的目的", () => {
      const state = createTerminalTuiWheelDistanceState();
      const reports = resolveTerminalTuiWheelReportCount(wheelNotch(), 1, state, CELL);
      expect(reports).toBeGreaterThanOrEqual(1);
    });

    it("对数压缩：一次滚很远也不会甩过整屏", () => {
      const state = createTerminalTuiWheelDistanceState();
      const huge = resolveTerminalTuiWheelReportCount(
        wheelNotch({ deltaY: 4000, wheelDeltaY: -4800 }),
        1,
        state,
        CELL,
      );
      // 上限是每事件 9 行（含连滚加成），远小于 4000/16 = 250 行
      expect(huge).toBeLessThanOrEqual(9);
    });

    it("连续快滚有加速，间隔拉大后回落", () => {
      const fast = createTerminalTuiWheelDistanceState();
      let fastTotal = 0;
      for (let i = 0; i < 4; i += 1) {
        fastTotal += resolveTerminalTuiWheelReportCount(
          wheelNotch({ timeStamp: i * 10 }),
          1,
          fast,
          CELL,
        );
      }

      const slow = createTerminalTuiWheelDistanceState();
      let slowTotal = 0;
      for (let i = 0; i < 4; i += 1) {
        slowTotal += resolveTerminalTuiWheelReportCount(
          wheelNotch({ timeStamp: i * 400 }),
          1,
          slow,
          CELL,
        );
      }

      expect(fastTotal).toBeGreaterThan(slowTotal);
    });
  });

  describe("触控板", () => {
    it("不足一行的增量结转，累计够一行才发——否则慢速滑动完全滚不动", () => {
      const state = createTerminalTuiWheelDistanceState();
      // 每次 6px，行高 16px：前两次都不足一行
      expect(resolveTerminalTuiWheelReportCount(trackpadTick(6), 1, state, CELL)).toBe(0);
      expect(resolveTerminalTuiWheelReportCount(trackpadTick(6), 1, state, CELL)).toBe(0);
      // 第三次累计 18px > 16px，应当发出 1 个
      expect(resolveTerminalTuiWheelReportCount(trackpadTick(6), 1, state, CELL)).toBe(1);
    });

    it("1:1 映射物理距离，不做压缩", () => {
      const state = createTerminalTuiWheelDistanceState();
      // 160px / 16px 行高 = 10 行，触控板路径不压缩
      expect(resolveTerminalTuiWheelReportCount(trackpadTick(160), 1, state, CELL)).toBe(10);
    });
  });

  describe("换向", () => {
    it("反向滚时清掉累计余量，避免第一下先往回走", () => {
      const state = createTerminalTuiWheelDistanceState();
      resolveTerminalTuiWheelReportCount(trackpadTick(12), 1, state, CELL);
      expect(state.pendingRows).toBeGreaterThan(0);

      resolveTerminalTuiWheelReportCount(trackpadTick(-4), 1, state, CELL);
      // 换向后余量必须来自新方向，不能带着旧方向的 0.75 行
      expect(state.pendingRows).toBeLessThan(0.75);
    });
  });

  describe("倍率", () => {
    it("越界与非法值都归一到合法区间", () => {
      expect(normalizeTerminalTuiWheelMultiplier(undefined)).toBe(
        TERMINAL_TUI_WHEEL_MULTIPLIER_DEFAULT,
      );
      expect(normalizeTerminalTuiWheelMultiplier(Number.NaN)).toBe(
        TERMINAL_TUI_WHEEL_MULTIPLIER_DEFAULT,
      );
      expect(normalizeTerminalTuiWheelMultiplier(0)).toBe(TERMINAL_TUI_WHEEL_MULTIPLIER_MIN);
      expect(normalizeTerminalTuiWheelMultiplier(999)).toBe(TERMINAL_TUI_WHEEL_MULTIPLIER_MAX);
    });

    it("倍率放大离散滚轮的报告数", () => {
      const base = createTerminalTuiWheelDistanceState();
      const boosted = createTerminalTuiWheelDistanceState();
      const one = resolveTerminalTuiWheelReportCount(wheelNotch(), 1, base, CELL);
      const four = resolveTerminalTuiWheelReportCount(wheelNotch(), 4, boosted, CELL);
      expect(four).toBeGreaterThan(one);
    });
  });

  describe("兜底", () => {
    it("拿不到行高时用默认值换算，不会返回 NaN", () => {
      const state = createTerminalTuiWheelDistanceState();
      const reports = resolveTerminalTuiWheelReportCount(wheelNotch(), 1, state, {});
      expect(Number.isFinite(reports)).toBe(true);
      expect(reports).toBeGreaterThanOrEqual(1);
    });
  });
});
