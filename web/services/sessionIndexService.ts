import type {
  SessionIndexEntry,
  SessionIndexListParams,
  SessionIndexScanReport,
} from "@/types/sessionIndex";
import { apiGet, apiJson, invokeOrApi } from "./apiClient";

export const sessionIndexService = {
  async list(params: SessionIndexListParams): Promise<SessionIndexEntry[]> {
    return invokeOrApi<SessionIndexEntry[]>("list_session_index", { params }, () =>
      apiGet<SessionIndexEntry[]>("/api/session-index", { ...params }),
    );
  },

  /** 按会话 id（终端标签的 resumeId）精确取索引条目；Web 模式无专用路由，退回列表后过滤。 */
  async lookup(sessionIds: string[]): Promise<SessionIndexEntry[]> {
    if (sessionIds.length === 0) return [];
    return invokeOrApi<SessionIndexEntry[]>("lookup_session_index", { sessionIds }, async () => {
      const wanted = new Set(sessionIds);
      const entries = await apiGet<SessionIndexEntry[]>("/api/session-index", { scope: "all", limit: 500 });
      return entries.filter((entry) => wanted.has(entry.sessionId));
    });
  },

  async refresh(): Promise<SessionIndexScanReport> {
    return invokeOrApi<SessionIndexScanReport>("refresh_session_index", undefined, () =>
      apiJson<SessionIndexScanReport>("/api/session-index/refresh", "POST"),
    );
  },

  async checkCodexRollout(
    sessionId: string,
    wslDistro?: string,
  ): Promise<boolean | null> {
    const params = { sessionId, wslDistro };
    return invokeOrApi<boolean | null>("check_codex_rollout_exists", params, () =>
      apiGet<boolean | null>("/api/session-index/codex-rollout-exists", params),
    );
  },
};
