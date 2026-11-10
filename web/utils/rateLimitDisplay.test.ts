import { describe, expect, it } from "vitest";
import type { RateLimitSnapshot } from "@/types/rateLimit";
import {
  activeRateLimitWindows,
  formatDuration,
  formatPercent,
  formatWindowLength,
  mostConstrainedWindow,
  rateLimitSeverity,
} from "./rateLimitDisplay";

/** 与 Rust 侧 fixture 同一行 Codex rollout 解析后的形状。 */
const codexSnapshot: RateLimitSnapshot = {
  source: "codex-session-log",
  windows: [
    { slot: "primary", usedPercent: 12.5, windowMinutes: 300, resetsAt: 10_000_000 },
    { slot: "secondary", usedPercent: 40, windowMinutes: 10080, resetsAt: 90_000_000 },
  ],
  planType: "pro",
  limitReachedType: null,
  observedAt: 1_000,
};

describe("rateLimitDisplay", () => {
  it.each([
    [300, "5h"],
    [10080, "7d"],
    [90, "90m"],
    [null, null],
    [0, null],
  ])("formats window %s as %s", (minutes, expected) => {
    expect(formatWindowLength(minutes)).toBe(expected);
  });

  it.each([
    [30_000, "<1m"],
    [12 * 60_000, "12m"],
    [3 * 3_600_000 + 12 * 60_000, "3h12m"],
    [5 * 3_600_000, "5h"],
    [2 * 86_400_000 + 3 * 3_600_000, "2d3h"],
    [7 * 86_400_000, "7d"],
  ])("formats duration %s as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it("drops windows whose reset time has passed", () => {
    expect(activeRateLimitWindows(codexSnapshot, 5_000).map((w) => w.slot)).toEqual([
      "primary",
      "secondary",
    ]);
    expect(activeRateLimitWindows(codexSnapshot, 10_000_000).map((w) => w.slot)).toEqual([
      "secondary",
    ]);
    expect(activeRateLimitWindows(codexSnapshot, 100_000_000)).toEqual([]);
    expect(activeRateLimitWindows(null, 0)).toEqual([]);
  });

  it("keeps windows without a reset time", () => {
    const snapshot = {
      ...codexSnapshot,
      windows: [{ slot: "primary", usedPercent: 5, windowMinutes: null, resetsAt: null }],
    };
    expect(activeRateLimitWindows(snapshot, Number.MAX_SAFE_INTEGER)).toHaveLength(1);
  });

  it("grades severity and picks the most used window", () => {
    expect(rateLimitSeverity(10)).toBe("normal");
    expect(rateLimitSeverity(75)).toBe("warning");
    expect(rateLimitSeverity(90)).toBe("danger");
    expect(rateLimitSeverity(10, true)).toBe("danger");
    expect(mostConstrainedWindow(codexSnapshot.windows)?.slot).toBe("secondary");
    expect(mostConstrainedWindow([])).toBeNull();
    expect(formatPercent(12.5)).toBe("13%");
  });
});
