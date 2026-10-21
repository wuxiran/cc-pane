import { LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
interface Props {
  hasMore: boolean;
  loading: boolean;
  onLoad: () => void;
  label?: string;
  error?: string | null;
  onRetry?: () => void;
}
export default function LoadMoreTasks({ hasMore, loading, onLoad, label, error, onRetry }: Props) {
  const { t } = useTranslation("orchestration");
  const showLoading = useDelayedLoading(loading, 200);
  if (!hasMore && !error) return null;
  return (
    <div className="flex flex-col items-center gap-2 py-3">
      {error ? (
        <div role="alert" className="w-full text-center text-xs text-[var(--app-status-danger)]">
          <p>{t("listLoadFailed")}</p>
          <details className="mt-1 text-[var(--app-text-secondary)]">
            <summary className="cursor-pointer">{t("listLoadDetails")}</summary>
            <p className="mt-1 break-words">{error}</p>
          </details>
        </div>
      ) : null}
      <Button type="button" variant="outline" size="sm" className="w-44" disabled={loading} onClick={error ? onRetry ?? onLoad : onLoad}>
        <span className="mr-1.5 h-3.5 w-3.5 shrink-0" aria-hidden="true">
          {showLoading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
        </span>
        {error ? t("sidebar.retry") : label ?? t("loadMore")}
      </Button>
    </div>
  );
}
