import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  hasMore: boolean;
  loading: boolean;
  onLoad: () => void;
  label?: string;
}

export default function LoadMoreTasks({ hasMore, loading, onLoad, label = "Load more tasks" }: Props) {
  if (!hasMore) return null;
  return (
    <div className="flex justify-center py-3">
      <Button type="button" variant="outline" size="sm" disabled={loading} onClick={onLoad}>
        {loading ? <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
        {label}
      </Button>
    </div>
  );
}
