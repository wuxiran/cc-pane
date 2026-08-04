export type ContextUsageStatus = "ready" | "waiting" | "stale" | "error";

export interface ContextUsageSnapshot {
  status: ContextUsageStatus;
  usedTokens: number | null;
  effectiveUsedTokens: number | null;
  windowTokens: number | null;
  effectiveWindowTokens: number | null;
  usedPercentage: number | null;
  remainingPercentage: number | null;
  model: string | null;
  usageSource: string | null;
  windowSource: string | null;
  agentSessionId: string | null;
  parserVersion: string | null;
  observedAt: number;
  diagnosticCode: string | null;
}
