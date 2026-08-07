export interface UsageTotals {
  charCount: number;
  tokenInput: number;
  tokenOutput: number;
  tokenCacheRead: number;
  tokenCacheCreation: number;
}

export interface UsageDayPoint {
  date: string;
  byCli?: Record<string, UsageTotals>;
  claudeChars: number;
  codexChars: number;
  unknownChars: number;
  claudeTokensIn: number;
  claudeTokensOut: number;
  claudeCacheRead: number;
  claudeCacheCreation: number;
  codexTokensIn: number;
  codexTokensOut: number;
  codexCacheRead: number;
  codexCacheCreation: number;
}

export interface UsageQueryResult {
  series: UsageDayPoint[];
  totals: UsageTotals;
  byCli: Record<string, UsageTotals>;
  workspaces: string[];
}
