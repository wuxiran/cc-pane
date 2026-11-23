// 状态栏用量弹窗的纯计算部分：按来源过滤、汇总、按天折线、按来源排行。
// 和设置页 HomeUsageStats 用同一套口径：处理量 = 新输入 + 缓存创建 + 缓存命中 + 输出；
// 命中率 = 缓存命中 / (新输入 + 缓存创建 + 缓存命中)。
import type { UsageDayPoint, UsageQueryResult, UsageTotals } from "@/types/usageStats";

export const EMPTY_TOTALS: UsageTotals = {
  charCount: 0,
  tokenInput: 0,
  tokenOutput: 0,
  tokenCacheRead: 0,
  tokenCacheCreation: 0,
};

export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    charCount: a.charCount + b.charCount,
    tokenInput: a.tokenInput + b.tokenInput,
    tokenOutput: a.tokenOutput + b.tokenOutput,
    tokenCacheRead: a.tokenCacheRead + b.tokenCacheRead,
    tokenCacheCreation: a.tokenCacheCreation + b.tokenCacheCreation,
  };
}

export function processedTokens(totals: UsageTotals): number {
  return totals.tokenInput + totals.tokenCacheCreation + totals.tokenCacheRead + totals.tokenOutput;
}

export function cacheHitRate(totals: UsageTotals): number | null {
  const cacheable = totals.tokenInput + totals.tokenCacheCreation + totals.tokenCacheRead;
  return cacheable > 0 ? totals.tokenCacheRead / cacheable : null;
}

function sumByCli(byCli: Record<string, UsageTotals> | undefined, source: string | null): UsageTotals {
  return Object.entries(byCli ?? {})
    .filter(([cli]) => source === null || cli === source)
    .reduce((sum, [, totals]) => addTotals(sum, totals), EMPTY_TOTALS);
}

/** 旧版后端的日点没有 byCli，只有 claude / codex 两组扁平字段，兜底拼出来。 */
function dayByCli(point: UsageDayPoint): Record<string, UsageTotals> {
  if (point.byCli) return point.byCli;
  return {
    claude: { charCount: point.claudeChars, tokenInput: point.claudeTokensIn, tokenOutput: point.claudeTokensOut, tokenCacheRead: point.claudeCacheRead, tokenCacheCreation: point.claudeCacheCreation },
    codex: { charCount: point.codexChars, tokenInput: point.codexTokensIn, tokenOutput: point.codexTokensOut, tokenCacheRead: point.codexCacheRead, tokenCacheCreation: point.codexCacheCreation },
  };
}

export interface UsageSourceRow {
  source: string;
  totals: UsageTotals;
  processed: number;
  share: number;
  hitRate: number | null;
}

export interface UsageReport {
  totals: UsageTotals;
  processed: number;
  hitRate: number | null;
  days: Array<{ date: string; processed: number }>;
  sources: UsageSourceRow[];
}

export function buildUsageReport(data: UsageQueryResult | null | undefined, source: string | null): UsageReport {
  const totals = sumByCli(data?.byCli, source);
  const processed = processedTokens(totals);
  const days = (data?.series ?? []).map((point) => ({
    date: point.date,
    processed: processedTokens(sumByCli(dayByCli(point), source)),
  }));
  const allProcessed = processedTokens(sumByCli(data?.byCli, null));
  const sources = Object.entries(data?.byCli ?? {})
    .map(([cli, cliTotals]) => ({
      source: cli,
      totals: cliTotals,
      processed: processedTokens(cliTotals),
      share: allProcessed > 0 ? processedTokens(cliTotals) / allProcessed : 0,
      hitRate: cacheHitRate(cliTotals),
    }))
    .filter((row) => row.processed > 0)
    .sort((a, b) => b.processed - a.processed);
  return { totals, processed, hitRate: cacheHitRate(totals), days, sources };
}
