import { apiGet, apiJson, invokeOrApi } from "./apiClient";
import type {
  ApplyForkChangesRequest,
  ApplyForkChangesResult,
  ForkComparison,
  ForkReviewRecord,
  PrepareChatForkRequest,
  PreparedChatFork,
} from "@/types/forkReview";

export const forkReviewService = {
  prepare(request: PrepareChatForkRequest): Promise<PreparedChatFork> {
    return invokeOrApi("prepare_chat_fork", { request }, () =>
      apiJson("/api/fork-reviews/prepare", "POST", request),
    );
  },
  list(): Promise<ForkReviewRecord[]> {
    return invokeOrApi("list_fork_reviews", undefined, () => apiGet("/api/fork-reviews"));
  },
  compare(id: string): Promise<ForkComparison> {
    return invokeOrApi("get_fork_comparison", { id }, () =>
      apiGet(`/api/fork-reviews/${encodeURIComponent(id)}`),
    );
  },
  apply(id: string, request: ApplyForkChangesRequest): Promise<ApplyForkChangesResult> {
    return invokeOrApi("apply_fork_changes", { id, request }, () =>
      apiJson(`/api/fork-reviews/${encodeURIComponent(id)}/apply`, "POST", request),
    );
  },
};
