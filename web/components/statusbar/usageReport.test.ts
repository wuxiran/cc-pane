import { describe, expect, it } from "vitest";
import { buildUsageReport, cacheHitRate } from "./usageReport";
import type { UsageQueryResult, UsageTotals } from "@/types/usageStats";

const totals = (input: number, output: number, read: number, creation: number): UsageTotals => ({
  charCount: 0, tokenInput: input, tokenOutput: output, tokenCacheRead: read, tokenCacheCreation: creation,
});

const flat = { claudeChars: 0, codexChars: 0, unknownChars: 0, claudeTokensIn: 0, claudeTokensOut: 0, claudeCacheRead: 0,
  claudeCacheCreation: 0, codexTokensIn: 0, codexTokensOut: 0, codexCacheRead: 0, codexCacheCreation: 0 };

const data: UsageQueryResult = {
  totals: totals(0, 0, 0, 0),
  workspaces: [],
  byCli: { claude: totals(10, 20, 60, 10), codex: totals(5, 5, 0, 0), gemini: totals(0, 0, 0, 0) },
  series: [
    { date: "2026-11-22", byCli: { claude: totals(10, 20, 60, 10) }, ...flat },
    { date: "2026-11-23", byCli: { codex: totals(5, 5, 0, 0) }, ...flat },
  ],
};

describe("buildUsageReport", () => {
  it("汇总全部来源，按处理量排序并去掉零用量来源", () => {
    const report = buildUsageReport(data, null);
    expect(report.processed).toBe(110);
    expect(report.sources.map((row) => row.source)).toEqual(["claude", "codex"]);
    expect(report.sources[0].share).toBeCloseTo(100 / 110);
    expect(report.days).toEqual([{ date: "2026-11-22", processed: 100 }, { date: "2026-11-23", processed: 10 }]);
  });

  it("按来源过滤时总量和每日都只算该来源，来源排行仍是全量", () => {
    const report = buildUsageReport(data, "codex");
    expect(report.processed).toBe(10);
    expect(report.days.map((day) => day.processed)).toEqual([0, 10]);
    expect(report.sources).toHaveLength(2);
  });

  it("旧版日点没有 byCli 时用扁平字段兜底", () => {
    const legacy: UsageQueryResult = { ...data, series: [{ date: "d", ...flat, claudeTokensIn: 3, codexTokensOut: 4 }] };
    expect(buildUsageReport(legacy, null).days[0].processed).toBe(7);
    expect(buildUsageReport(legacy, "codex").days[0].processed).toBe(4);
  });

  it("命中率无可缓存输入时为 null", () => {
    expect(cacheHitRate(totals(0, 9, 0, 0))).toBeNull();
    expect(cacheHitRate(totals(10, 0, 60, 10))).toBeCloseTo(0.75);
  });

  it("没有数据时返回空报表", () => {
    expect(buildUsageReport(null, null)).toMatchObject({ processed: 0, hitRate: null, days: [], sources: [] });
  });
});
