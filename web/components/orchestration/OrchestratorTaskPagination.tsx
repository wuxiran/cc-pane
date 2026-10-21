import { useOrchestratorStore } from "@/stores/useOrchestratorStore";
import LoadMoreTasks from "./LoadMoreTasks";
/** Both orchestration surfaces share the same expanded window and retry state. */
export default function OrchestratorTaskPagination() {
  const hasMore = useOrchestratorStore((state) => state.hasMore);
  const loading = useOrchestratorStore((state) => state.loading);
  const error = useOrchestratorStore((state) => state.loadError);
  const loadMore = useOrchestratorStore((state) => state.loadMoreBindings);
  const retry = useOrchestratorStore((state) => state.retryBindings);
  return <LoadMoreTasks hasMore={hasMore} loading={loading} error={error} onLoad={() => void loadMore()} onRetry={() => void retry()} />;
}
