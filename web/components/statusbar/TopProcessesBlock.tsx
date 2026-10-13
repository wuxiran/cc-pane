import { useTranslation } from "react-i18next";
import type { TopProcessInfo } from "@/types";
import { formatSize } from "@/utils";

interface TopProcessesBlockProps {
  /** 后端只在整机 CPU ≥ 60% 时给值；undefined/null = 未计算（旧后端或负载不高）。 */
  topProcesses: TopProcessInfo[] | null | undefined;
}

function formatCpu(cpuPercent: number): string {
  return `${Math.round(cpuPercent * 10) / 10}%`;
}

/**
 * 资源管理器"会话之外"块：整机高负载但受管会话都不重时，告诉用户元凶在外面。
 *
 * **只读**：不提供杀 / 降优先级——对会话外进程操作错一次的代价远高于看一眼。
 */
export function TopProcessesBlock({ topProcesses }: TopProcessesBlockProps) {
  const { t } = useTranslation("common");
  if (!topProcesses || topProcesses.length === 0) return null;
  return (
    <div className="mt-2 border-t border-[var(--app-border)] pt-2" data-testid="top-processes-block">
      <div className="flex min-h-7 items-center gap-2 px-1">
        <span className="text-xs font-medium" style={{ color: "var(--app-status-warning)" }}>
          {t("resourceManagerTopProcesses")}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--app-text-tertiary)]">
          {t("resourceManagerTopProcessesHint")}
        </span>
      </div>
      {topProcesses.map((process) => (
        <div key={process.pid} className="flex min-h-7 items-center gap-2 pl-6 pr-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-[var(--app-text-secondary)]">
            {process.name}
          </span>
          <span className="shrink-0 tabular-nums text-[11px] text-[var(--app-text-tertiary)]">
            PID {process.pid} · {formatCpu(process.cpuPercent)} · {formatSize(process.memoryBytes)}
          </span>
        </div>
      ))}
    </div>
  );
}

export default TopProcessesBlock;
