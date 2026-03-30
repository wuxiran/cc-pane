import { useCallback } from "react";
import { Trash2 } from "lucide-react";
import { useOrchestratorStore } from "@/stores";
import type { TaskBinding } from "@/types";

/** 简易相对时间格式化 */
function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

interface OrchestratorTaskCardProps {
  binding: TaskBinding;
}

const STATUS_CONFIG: Record<string, { color: string; emoji: string }> = {
  pending: { color: "var(--app-text-tertiary)", emoji: "⏳" },
  running: { color: "#22c55e", emoji: "🟢" },
  waiting: { color: "#eab308", emoji: "🟡" },
  completed: { color: "#22c55e", emoji: "✅" },
  failed: { color: "#ef4444", emoji: "❌" },
};

export default function OrchestratorTaskCard({ binding }: OrchestratorTaskCardProps) {
  const remove = useOrchestratorStore((s) => s.remove);

  const config = STATUS_CONFIG[binding.status] || STATUS_CONFIG.pending;

  const handleClick = useCallback(() => {
    if (binding.sessionId) {
      // 派发自定义事件让 panes 层跳转到对应终端 tab
      window.dispatchEvent(
        new CustomEvent("cc-panes:focus-session", { detail: { sessionId: binding.sessionId } })
      );
    }
  }, [binding.sessionId]);

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      remove(binding.id);
    },
    [binding.id, remove]
  );

  const timeAgo = formatTimeAgo(binding.createdAt);

  return (
    <div
      className="group flex flex-col gap-1 p-2 my-1 rounded-md cursor-pointer transition-colors hover:bg-[var(--app-hover)]"
      style={{ border: "1px solid var(--app-border)" }}
      onClick={handleClick}
      title={binding.prompt || binding.title}
    >
      {/* 标题行 */}
      <div className="flex items-start gap-1.5">
        <span className="text-xs shrink-0 mt-0.5">{config.emoji}</span>
        <span
          className="text-xs font-medium flex-1 truncate"
          style={{ color: "var(--app-text-primary)" }}
        >
          {binding.title}
        </span>
        <button
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--app-hover)] transition-opacity"
          onClick={handleDelete}
          title="Delete"
        >
          <Trash2 className="w-3 h-3" style={{ color: "var(--app-text-tertiary)" }} />
        </button>
      </div>

      {/* 元信息行 */}
      <div className="flex items-center gap-1.5 text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>
        <span>{binding.cliTool}</span>
        <span>·</span>
        <span className="truncate max-w-[120px]">
          {binding.projectPath.split(/[/\\]/).pop()}
        </span>
        <span>·</span>
        <span>{binding.status === "completed" ? "done" : timeAgo}</span>
      </div>

      {/* 进度条 */}
      {binding.status !== "pending" && (
        <div
          className="h-1 rounded-full overflow-hidden mt-0.5"
          style={{ background: "var(--app-border)" }}
        >
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${binding.progress}%`,
              background: config.color,
            }}
          />
        </div>
      )}

      {/* 完成摘要 */}
      {binding.completionSummary && (
        <p
          className="text-[10px] mt-0.5 line-clamp-2"
          style={{ color: "var(--app-text-secondary)" }}
        >
          {binding.completionSummary}
        </p>
      )}
    </div>
  );
}
