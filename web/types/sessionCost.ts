import type { ContextUsageStatus } from "./contextUsage";

export interface SessionCostModelEntry {
  model: string;
  /** null when the model has no published price. */
  costUsd: number | null;
}

/** Estimated spend of one agent session, including its subagents, at public API prices. */
export interface SessionCostSnapshot {
  status: ContextUsageStatus;
  costUsd: number | null;
  hasUnpricedUsage: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  models: SessionCostModelEntry[];
  pricingAsOf: string;
  agentSessionId: string | null;
  observedAt: number;
  diagnosticCode: string | null;
}
