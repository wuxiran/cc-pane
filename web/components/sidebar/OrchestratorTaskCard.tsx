import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { CornerLeftUp, FolderTree, GitBranch, Users } from "lucide-react";
import CliBrandIcon from "@/components/CliBrandIcon";
import { focusTab } from "@/hooks/useFocusTab";
import { localHistoryService } from "@/services";
import { useActivityBarStore, useOrchestratorStore, usePanesStore } from "@/stores";
import { asTabId } from "@/types/ids";
import type { TaskBinding } from "@/types";
import CurrentActivityBadge from "./CurrentActivityBadge";
import OrchestratorTaskActions from "./OrchestratorTaskActions";
import { TaskRoleIcon, TaskStatusLabel } from "./OrchestratorTaskVisuals";
import { getMetadataUi, getProjectName } from "./OrchestratorTaskUtils";

type Translate = TFunction<"orchestration">;

function formatTimeAgo(dateStr: string, t: Translate): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("timeAgo.now");
  if (mins < 60) return t("timeAgo.minutes", { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("timeAgo.hours", { count: hours });
  return t("timeAgo.days", { count: Math.floor(hours / 24) });
}

async function readGitBranch(projectPath: string): Promise<string | undefined> {
  try {
    const branch = await localHistoryService.getCurrentBranch(projectPath);
    return branch || undefined;
  } catch {
    return undefined;
  }
}

function truncateSummary(summary?: string): string {
  if (!summary) return "";
  const compact = summary.trim().replace(/\s+/g, " ");
  if (compact.length <= 100) return compact;
  return `${compact.slice(0, 100)}...`;
}

function focusSessionTab(sessionId: string): void {
  const panes = usePanesStore.getState();
  const location = panes.findTabBySessionAcrossLayouts(sessionId);
  if (!location) return;
  focusTab(asTabId(location.tab.id), { switchAppView: true });
}

/** 懒读分支：metadata 里没有时才问一次 git。 */
function useGitBranch(binding: TaskBinding): string | undefined {
  const metaBranch = getMetadataUi(binding).gitBranch;
  const [fallbackBranch, setFallbackBranch] = useState<string | undefined>();
  const [branchLoaded, setBranchLoaded] = useState(false);

  useEffect(() => {
    if (metaBranch || branchLoaded) return;
    let cancelled = false;
    readGitBranch(binding.projectPath).then((branch) => {
      if (!cancelled) {
        setFallbackBranch(branch);
        setBranchLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [binding.projectPath, branchLoaded, metaBranch]);

  return metaBranch || fallbackBranch;
}

const META_SEPARATOR = <span aria-hidden className="shrink-0">·</span>;

interface OrchestratorTaskCardProps {
  binding: TaskBinding;
  depth?: number;
  /** 树视图自己处理缩进时传 false */
  indent?: boolean;
}

export default function OrchestratorTaskCard({ binding, depth = 0, indent = true }: OrchestratorTaskCardProps) {
  const { t } = useTranslation("orchestration");
  const bindings = useOrchestratorStore((s) => s.bindings);
  const selectedTaskId = useOrchestratorStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useOrchestratorStore((s) => s.setSelectedTaskId);
  const gitBranch = useGitBranch(binding);

  const ui = getMetadataUi(binding);
  const leader = binding.parentId
    ? bindings.find((candidate) => candidate.id === binding.parentId)
    : undefined;
  const workers = useMemo(
    () => bindings.filter((candidate) => candidate.parentId === binding.id),
    [binding.id, bindings]
  );
  const runningWorkers = workers.filter((worker) => worker.status === "running").length;
  const doneWorkers = workers.filter((worker) => worker.status === "completed").length;
  const isWorktree = ui.isWorktree || ui.worktree || /[/\\]\.worktrees?[/\\]/.test(binding.projectPath);
  const selected = selectedTaskId === binding.id;
  const running = binding.status === "running";
  const failed = binding.status === "failed";

  const handleFocusSession = useCallback((task: TaskBinding) => {
    setSelectedTaskId(task.id);
    if (task.sessionId) {
      focusSessionTab(task.sessionId);
    }
  }, [setSelectedTaskId]);

  const failedSummary = failed ? truncateSummary(binding.completionSummary) : "";
  const hasFailureDetail = failed && (binding.exitCode != null || Boolean(failedSummary));

  return (
    <div
      role="button"
      tabIndex={0}
      data-current={selected ? "true" : undefined}
      className="group my-1 flex cursor-default flex-col gap-1 rounded-md border px-2.5 py-2 transition-colors hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
      style={{
        marginLeft: indent && depth > 0 ? Math.min(depth * 14, 42) : undefined,
        borderColor: selected ? "var(--app-accent)" : "var(--app-border)",
        background: selected ? "color-mix(in srgb, var(--app-accent) 10%, transparent)" : undefined,
      }}
      onClick={() => handleFocusSession(binding)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleFocusSession(binding);
        }
      }}
      title={binding.prompt || binding.title}
    >
      {/* 第一行：角色 + 标题 + 状态（唯一一处状态表达）+ 悬停菜单 */}
      <div className="flex min-w-0 items-center gap-1.5">
        <TaskRoleIcon role={binding.role} className="text-[var(--app-text-tertiary)]" />
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-row)] font-medium text-[var(--app-text-primary)]">
          {binding.title}
        </span>
        {/* 菜单收起时零宽，悬停/聚焦才展开，状态标签贴住卡片右内边距 */}
        <div className="flex shrink-0 items-center gap-0.5">
          <TaskStatusLabel status={binding.status} />
          <OrchestratorTaskActions binding={binding} />
        </div>
      </div>

      {leader && (
        <button
          type="button"
          className="flex min-w-0 max-w-full items-center gap-1 self-start text-left text-[length:var(--text-micro)] text-[var(--app-text-secondary)] hover:text-[var(--app-text-primary)] hover:underline"
          onClick={(event) => {
            event.stopPropagation();
            handleFocusSession(leader);
          }}
        >
          <CornerLeftUp aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{t("card.leaderPrefix")}: {leader.title}</span>
        </button>
      )}

      {/* 元信息：CLI · 项目 · 时间 · 分支，单行，长分支截断 */}
      <div className="flex min-w-0 items-center gap-1.5 text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">
        <span className="inline-flex shrink-0 items-center gap-1">
          <CliBrandIcon cliTool={binding.cliTool} className="size-3" />
          <span>{binding.cliTool}</span>
        </span>
        {META_SEPARATOR}
        <span className="min-w-0 max-w-[40%] shrink truncate">{getProjectName(binding.projectPath)}</span>
        {META_SEPARATOR}
        <span className="shrink-0 tabular-nums">{formatTimeAgo(binding.createdAt, t)}</span>
        {gitBranch && (
          <>
            {META_SEPARATOR}
            <span
              data-testid="task-branch"
              className="inline-flex min-w-0 items-center gap-0.5"
              title={`${t("card.branch")}: ${gitBranch}`}
            >
              {isWorktree ? (
                <FolderTree aria-label={t("card.worktree")} role="img" className="size-3 shrink-0" />
              ) : (
                <GitBranch aria-hidden className="size-3 shrink-0" />
              )}
              <span className="truncate">{gitBranch}</span>
            </span>
          </>
        )}
        {workers.length > 0 && (
          <span
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-[var(--app-text-secondary)]"
            title={t("card.workersTitle", { running: runningWorkers, done: doneWorkers })}
          >
            <Users aria-hidden className="size-3" />
            {t("card.workers", { count: workers.length })}
          </span>
        )}
      </div>

      {running && (
        <>
          <CurrentActivityBadge binding={binding} />
          <div
            role="progressbar"
            aria-valuenow={binding.progress}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1 overflow-hidden rounded-full bg-[var(--app-border)]"
          >
            <div
              className="h-full rounded-full bg-[var(--app-accent)] transition-[width] duration-[var(--dur)]"
              style={{ width: `${binding.progress}%` }}
            />
          </div>
        </>
      )}

      {!failed && binding.completionSummary && (
        <p className="line-clamp-2 text-[length:var(--text-micro)] text-[var(--app-text-secondary)]">
          {binding.completionSummary}
        </p>
      )}

      {hasFailureDetail && (
        <button
          type="button"
          title={t("card.failureDetails")}
          className="min-w-0 truncate text-left text-[length:var(--text-micro)] text-[var(--app-text-secondary)] hover:text-[var(--app-text-primary)] hover:underline"
          onClick={(event) => {
            event.stopPropagation();
            setSelectedTaskId(binding.id);
            useActivityBarStore.getState().openOrchestrationOverlay();
          }}
        >
          {[
            binding.exitCode != null ? t("card.exit", { code: binding.exitCode }) : null,
            failedSummary || null,
          ].filter(Boolean).join(" · ")}
        </button>
      )}
    </div>
  );
}
