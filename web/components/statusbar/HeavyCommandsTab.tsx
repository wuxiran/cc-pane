import { RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { heavyCommandService } from "@/services/heavyCommandService";
import { toastErr } from "@/lib/feedback";
import type { HeavyCommandAggregate, HeavyCommandRecord } from "@/types/heavyCommand";
import { formatSize, handleErrorSilent } from "@/utils";

/** 聚合窗口：7 天。 */
export const HEAVY_COMMANDS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** 项目筛选项从这批最近行里取（只为列出有过记录的项目，不是全量列表）。 */
const PROJECT_SCAN_LIMIT = 500;
const ALL_PROJECTS = "";

export function formatDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes - hours * 60}m`;
}

export function formatCpuSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0";
  if (seconds < 100) return seconds.toFixed(1);
  if (seconds < 3600) return `${Math.round(seconds)}`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

/** 项目路径最后一段作为展示名；相同名字的不同路径保留全路径以免混淆。 */
export function projectLabel(projectPath: string): string {
  const trimmed = projectPath.replace(/[\\/]+$/, "");
  const name = trimmed.split(/[\\/]/).pop();
  return name && name.length > 0 ? name : projectPath;
}

interface HeavyCommandsTabProps {
  /** 只在标签打开时为 true；关着不拉取。 */
  active: boolean;
}

export function HeavyCommandsTab({ active }: HeavyCommandsTabProps) {
  const { t } = useTranslation("common");
  const [aggregates, setAggregates] = useState<HeavyCommandAggregate[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [projectFilter, setProjectFilter] = useState<string>(ALL_PROJECTS);
  const [loading, setLoading] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const since = Date.now() - HEAVY_COMMANDS_WINDOW_MS;
    const project = projectFilter === ALL_PROJECTS ? null : projectFilter;
    try {
      const [rows, next] = await Promise.all([
        heavyCommandService.list({ since, limit: PROJECT_SCAN_LIMIT }),
        heavyCommandService.aggregate(since, project),
      ]);
      setProjects(distinctProjects(rows));
      setAggregates(next);
      setLoaded(true);
    } catch (error) {
      handleErrorSilent(error, "load heavy commands");
    } finally {
      setLoading(false);
    }
  }, [projectFilter]);

  useEffect(() => {
    if (!active) {
      setClearArmed(false);
      return;
    }
    void refresh();
  }, [active, refresh]);

  const clear = async () => {
    try {
      await heavyCommandService.clear();
      setClearArmed(false);
      await refresh();
    } catch (error) {
      toastErr(t("heavyCommandsClearFailed"));
      handleErrorSilent(error, "clear heavy commands");
    }
  };

  const totalCpu = useMemo(
    () => aggregates.reduce((sum, row) => sum + row.totalCpuSeconds, 0),
    [aggregates],
  );

  return (
    <div className="p-2" data-testid="heavy-commands-tab">
      <div className="mb-2 flex items-center gap-2 px-1">
        <select
          aria-label={t("heavyCommandsProjectFilter")}
          value={projectFilter}
          onChange={(event) => setProjectFilter(event.target.value)}
          className="min-w-0 flex-1 truncate rounded bg-[var(--app-panel-bg)] px-2 py-1 text-xs"
        >
          <option value={ALL_PROJECTS}>{t("heavyCommandsAllProjects")}</option>
          {projects.map((project) => (
            <option key={project} value={project} title={project}>
              {projectLabel(project)}
            </option>
          ))}
        </select>
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--app-text-tertiary)]">
          {t("heavyCommandsWindow")} · {t("heavyCommandsTotalCpu", { seconds: formatCpuSeconds(totalCpu) })}
        </span>
        <IconTooltipButton
          label={t("heavyCommandsRefresh")}
          className="h-7 w-7"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </IconTooltipButton>
        {clearArmed ? (
          <Button
            size="sm"
            variant="destructive"
            className="h-7 px-2 text-[11px]"
            onClick={() => void clear()}
          >
            {t("heavyCommandsConfirmClear")}
          </Button>
        ) : (
          <IconTooltipButton
            label={t("heavyCommandsClear")}
            className="h-7 w-7 hover:text-[var(--app-status-danger)]"
            disabled={aggregates.length === 0}
            onClick={() => setClearArmed(true)}
          >
            <Trash2 className="size-3.5" />
          </IconTooltipButton>
        )}
      </div>

      {loaded && aggregates.length === 0 ? (
        <div className="px-2 py-6 text-center text-xs text-[var(--app-text-tertiary)]">
          {t("heavyCommandsEmpty")}
        </div>
      ) : (
        <table className="w-full table-fixed text-[11px]">
          <thead className="text-left text-[10px] uppercase text-[var(--app-text-tertiary)]">
            <tr>
              <th className="px-1 py-1 font-medium">{t("heavyCommandsColCommand")}</th>
              <th className="w-10 px-1 py-1 text-right font-medium">{t("heavyCommandsColRuns")}</th>
              <th className="w-14 px-1 py-1 text-right font-medium">{t("heavyCommandsColCpuSeconds")}</th>
              <th className="w-14 px-1 py-1 text-right font-medium">{t("heavyCommandsColP50")}</th>
              <th className="w-14 px-1 py-1 text-right font-medium">{t("heavyCommandsColP95")}</th>
              <th className="w-16 px-1 py-1 text-right font-medium">{t("heavyCommandsColPeakMem")}</th>
            </tr>
          </thead>
          <tbody className="tabular-nums text-[var(--app-text-secondary)]">
            {aggregates.map((row) => (
              <tr key={row.cmdNormalized} className="h-7 border-t border-[var(--app-border)]">
                <td className="truncate px-1 font-mono text-[var(--app-text-primary)]" title={row.cmdNormalized}>
                  {row.cmdNormalized}
                </td>
                <td className="px-1 text-right">{row.runs}</td>
                <td className="px-1 text-right">{formatCpuSeconds(row.totalCpuSeconds)}</td>
                <td className="px-1 text-right">{formatDurationMs(row.p50DurationMs)}</td>
                <td className="px-1 text-right">{formatDurationMs(row.p95DurationMs)}</td>
                <td className="px-1 text-right">
                  {row.peakMemBytes && row.peakMemBytes > 0 ? formatSize(row.peakMemBytes) : "–"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function distinctProjects(rows: HeavyCommandRecord[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.projectPath) seen.add(row.projectPath);
  }
  return [...seen].sort((left, right) => projectLabel(left).localeCompare(projectLabel(right)));
}

export default HeavyCommandsTab;
