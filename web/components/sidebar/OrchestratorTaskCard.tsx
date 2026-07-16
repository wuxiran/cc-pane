import { useCallback, useEffect, useMemo, useState } from "react";
import { localHistoryService } from "@/services";
import { useActivityBarStore, useOrchestratorStore, usePanesStore } from "@/stores";
import type { TaskBinding } from "@/types";
import CurrentActivityBadge from "./CurrentActivityBadge";
import OrchestratorTaskActions from "./OrchestratorTaskActions";
import { getMetadataUi, getProjectName } from "./OrchestratorTaskUtils";

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

const STATUS_CONFIG: Record<string, { color: string; emoji: string }> = {
  pending: { color: "var(--app-text-tertiary)", emoji: "⏳" },
  // fix(M2) review: 状态色统一走 CSS 变量。
  running: { color: "var(--app-status-success)", emoji: "🟢" },
  waiting: { color: "var(--app-status-warning)", emoji: "🟡" },
  completed: { color: "var(--app-status-success)", emoji: "✅" },
  failed: { color: "var(--app-status-danger)", emoji: "❌" },
};

const ROLE_CONFIG: Record<TaskBinding["role"], { emoji: string; color: string; label: string }> = {
  leader: { emoji: "📋", color: "var(--chart-3)", label: "leader" },
  worker: { emoji: "⚙️", color: "var(--app-accent)", label: "worker" },
  task: { emoji: "🎯", color: "var(--app-text-tertiary)", label: "task" },
};

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
  if (location.layoutId !== panes.currentLayoutId) {
    panes.switchLayout(location.layoutId);
  }
  const tabIndex = location.panel.tabs.findIndex((tab) => tab.id === location.tab.id);
  // fix(C3) review: 不再发送 dead event，直接激活匹配 session 的 pane/tab。
  panes.setActivePane(location.panel.id);
  panes.switchToTab(location.panel.id, tabIndex);
}

interface OrchestratorTaskCardProps {
  binding: TaskBinding;
  depth?: number;
}

export default function OrchestratorTaskCard({ binding, depth = 0 }: OrchestratorTaskCardProps) {
  const bindings = useOrchestratorStore((s) => s.bindings);
  const selectedTaskId = useOrchestratorStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useOrchestratorStore((s) => s.setSelectedTaskId);
  const [fallbackBranch, setFallbackBranch] = useState<string | undefined>();
  const [branchLoaded, setBranchLoaded] = useState(false);

  const ui = getMetadataUi(binding);
  const config = STATUS_CONFIG[binding.status] || STATUS_CONFIG.pending;
  const roleConfig = ROLE_CONFIG[binding.role] || ROLE_CONFIG.task;
  const leader = binding.parentId
    ? bindings.find((candidate) => candidate.id === binding.parentId)
    : undefined;
  const workers = useMemo(
    () => bindings.filter((candidate) => candidate.parentId === binding.id),
    [binding.id, bindings]
  );
  const runningWorkers = workers.filter((worker) => worker.status === "running").length;
  const doneWorkers = workers.filter((worker) => worker.status === "completed").length;
  const gitBranch = ui.gitBranch || fallbackBranch;
  const isWorktree = ui.isWorktree || ui.worktree || /[/\\]\.worktrees?[/\\]/.test(binding.projectPath);
  const selected = selectedTaskId === binding.id;

  useEffect(() => {
    if (ui.gitBranch || branchLoaded) return;
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
  }, [binding.projectPath, branchLoaded, ui.gitBranch]);

  const handleFocusSession = useCallback((task: TaskBinding) => {
    setSelectedTaskId(task.id);
    if (task.sessionId) {
      focusSessionTab(task.sessionId);
    }
  }, [setSelectedTaskId]);

  const timeAgo = formatTimeAgo(binding.createdAt);
  const failedSummary = binding.status === "failed" ? truncateSummary(binding.completionSummary) : "";

  return (
    <div
      className="group my-1 flex cursor-pointer flex-col gap-1 rounded-md p-2 transition-colors hover:bg-[var(--app-hover)]"
      style={{
        marginLeft: depth > 0 ? Math.min(depth * 14, 42) : undefined,
        border: selected ? "1px solid var(--app-accent)" : "1px solid var(--app-border)",
        borderLeft: `3px solid ${roleConfig.color}`,
        background: selected ? "color-mix(in srgb, var(--app-accent) 10%, transparent)" : undefined,
      }}
      onClick={() => handleFocusSession(binding)}
      title={binding.prompt || binding.title}
    >
      <div className="flex items-start gap-1.5">
        <span className="mt-0.5 shrink-0 text-xs" title={roleConfig.label}>
          {roleConfig.emoji}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1">
            <span
              className="min-w-0 flex-1 truncate text-xs font-medium"
              style={{ color: "var(--app-text-primary)" }}
            >
              {binding.title}
            </span>
            <span className="shrink-0 text-[10px]" style={{ color: config.color }}>
              {config.emoji}
            </span>
          </div>
          {leader && (
            <button
              className="mt-0.5 block max-w-full truncate text-left text-[10px] hover:underline"
              style={{ color: "var(--chart-3)" }}
              onClick={(event) => {
                event.stopPropagation();
                handleFocusSession(leader);
              }}
              title={leader.title}
            >
              📋 Leader: {leader.title.length > 30 ? `${leader.title.slice(0, 30)}...` : leader.title}
            </button>
          )}
        </div>
        <OrchestratorTaskActions binding={binding} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>
        <span>{binding.cliTool}</span>
        <span>·</span>
        <span className="max-w-[120px] truncate">{getProjectName(binding.projectPath)}</span>
        <span>·</span>
        <span>{binding.status === "completed" ? "done" : timeAgo}</span>
      </div>

      <div className="flex min-w-0 items-center gap-1.5">
        <CurrentActivityBadge binding={binding} />
        {gitBranch && (
          <span
            className="inline-flex min-w-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px]"
            style={{
              color: "var(--app-text-secondary)",
              background: "var(--app-input-bg)",
              border: "1px solid var(--app-border)",
            }}
            title={`${binding.projectPath} · ${gitBranch}`}
          >
            {isWorktree && <span>🌳</span>}
            <span className="truncate">🌿 {gitBranch}</span>
          </span>
        )}
        {workers.length > 0 && (
          <span
            className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px]"
            style={{
              color: "var(--app-accent)",
              background: "var(--app-input-bg)",
              border: "1px solid var(--app-border)",
            }}
            title={`${runningWorkers} running, ${doneWorkers} done`}
          >
            ⚙️ {workers.length} workers
          </span>
        )}
      </div>

      {binding.status !== "pending" && (
        <div className="mt-0.5 h-1 overflow-hidden rounded-full" style={{ background: "var(--app-border)" }}>
          <div
            className="h-full rounded-full transition-all duration-[var(--dur)]"
            style={{
              width: `${binding.progress}%`,
              background: config.color,
            }}
          />
        </div>
      )}

      {binding.status !== "failed" && binding.completionSummary && (
        <p className="mt-0.5 line-clamp-2 text-[10px]" style={{ color: "var(--app-text-secondary)" }}>
          {binding.completionSummary}
        </p>
      )}

      {binding.status === "failed" && (
        <button
          className="mt-1 rounded-sm border-l-2 px-2 py-1 text-left text-[10px]"
          style={{
            borderColor: "var(--app-status-danger)",
            background: "color-mix(in srgb, var(--app-status-danger) 12%, transparent)",
            color: "var(--app-text-primary)",
          }}
          onClick={(event) => {
            event.stopPropagation();
            setSelectedTaskId(binding.id);
            useActivityBarStore.getState().openOrchestrationOverlay();
          }}
        >
          <span className="font-medium" style={{ color: "var(--app-status-danger)" }}>
            Failed
          </span>
          {binding.exitCode != null && <span> · exit {binding.exitCode}</span>}
          {failedSummary && <span> · {failedSummary}</span>}
        </button>
      )}
    </div>
  );
}
