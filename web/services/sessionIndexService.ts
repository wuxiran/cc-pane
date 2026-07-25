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
