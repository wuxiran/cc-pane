import type { UsageQueryResult } from "@/types/usageStats";
import type { ContextUsageSnapshot } from "@/types/contextUsage";
import { apiGet, apiJson, invokeOrApi } from "./apiClient";

export const usageStatsService = {
  async queryContextUsage(ptySessionId: string): Promise<ContextUsageSnapshot> {
    return invokeOrApi<ContextUsageSnapshot>(
      "query_context_usage",
      { ptySessionId },
      () => apiGet<ContextUsageSnapshot>(`/api/context-usage/${encodeURIComponent(ptySessionId)}`),
    );
  },

  async queryUsage(
    rangeDays: number,
    workspaceFilter?: string | null,
  ): Promise<UsageQueryResult> {
    const args = { rangeDays, workspaceFilter: workspaceFilter || null };
    return invokeOrApi<UsageQueryResult>("query_usage_stats", args, () =>
      apiGet<UsageQueryResult>("/api/usage-stats", args),
    );
  },

  async refreshUsage(): Promise<void> {
    return invokeOrApi<void>("refresh_usage_stats", undefined, () =>
      apiJson<void>("/api/usage-stats/refresh", "POST"),
    );
  },

  async recordInputChars(sessionId: string, charCount: number): Promise<void> {
    if (charCount <= 0) return;
    return invokeOrApi<void>("record_terminal_input", { sessionId, charCount }, () =>
      apiJson<void>("/api/usage-stats/input", "POST", { sessionId, charCount }),
    );
  },
};
