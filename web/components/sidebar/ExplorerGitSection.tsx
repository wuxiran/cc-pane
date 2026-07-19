// Explorer Git 视图：工作空间下所有项目各一组（项目名 + 分支徽标 + 变更计数），只读展示。
// 选中项目的组默认展开显示变更文件列表，其他组折叠、点击组头可展开。
// 非 git 项目灰字提示；WSL/SSH 查询失败静默容错显示"不可用"，不抛错刷屏。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, GitBranch, RefreshCw } from "lucide-react";
import { apiGet, invokeOrApi } from "@/services/apiClient";
import { filesystemService } from "@/services/filesystemService";
import { getProjectName } from "@/utils/path";
import type { Workspace, WorkspaceProject } from "@/types";

type GitProjectKind = "loading" | "git" | "none" | "unavailable";

interface GitProjectState {
  kind: GitProjectKind;
  branch: string | null;
  /** [绝对路径, 状态] 列表，状态为 modified/added/deleted/untracked/renamed */
  changes: Array<[string, string]>;
}

const LOADING_STATE: GitProjectState = { kind: "loading", branch: null, changes: [] };

/** 与 FileTreeNode 的 GIT_STATUS_COLORS 同源的状态配色 + 单字母标记 */
const STATUS_BADGES: Record<string, { letter: string; className: string }> = {
  modified: { letter: "M", className: "text-[var(--app-status-warning)]" },
  added: { letter: "A", className: "text-[var(--app-status-success)]" },
  deleted: { letter: "D", className: "text-[var(--app-status-danger)]" },
  untracked: { letter: "U", className: "text-[var(--app-status-success)]" },
  renamed: { letter: "R", className: "text-[var(--app-accent)]" },
};

function toRelativePath(filePath: string, rootPath: string): string {
  const normalizedFile = filePath.replace(/\\/g, "/");
  const normalizedRoot = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalizedFile.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) {
    return normalizedFile.slice(normalizedRoot.length + 1);
  }
  return normalizedFile;
}

async function fetchGitState(projectPath: string): Promise<GitProjectState> {
  let branch: string | null;
  try {
    branch = await invokeOrApi<string | null>("get_git_branch", { path: projectPath }, () =>
      apiGet<string | null>("/api/git/branch", { path: projectPath }),
    );
  } catch {
    return { kind: "unavailable", branch: null, changes: [] };
  }
  if (!branch) {
    return { kind: "none", branch: null, changes: [] };
  }
  const statuses = await filesystemService.getGitFileStatuses(projectPath).catch(() => ({}));
  return {
    kind: "git",
    branch,
    changes: Object.entries(statuses).sort((a, b) => a[0].localeCompare(b[0])),
  };
}

interface GitProjectGroupProps {
  project: WorkspaceProject;
  expanded: boolean;
  onToggle: () => void;
}

function GitProjectGroup({ project, expanded, onToggle }: GitProjectGroupProps) {
  const { t } = useTranslation("sidebar");
  const [state, setState] = useState<GitProjectState>(LOADING_STATE);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState(LOADING_STATE);
    fetchGitState(project.path).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [project.path, reloadTick]);

  const handleRefresh = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setReloadTick((n) => n + 1);
  }, []);

  const name = project.alias || getProjectName(project.path);
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div className="flex flex-col">
      {/* 组头：项目名 + 分支徽标 + 变更计数，hover 出刷新 */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onToggle();
        }}
        className="group/gitgroup flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-[var(--app-hover)]"
        title={project.path}
      >
        <Chevron className="h-3 w-3 shrink-0 text-[var(--app-text-tertiary)]" />
        <span className="shrink-0 text-xs font-semibold text-[var(--app-text-primary)]">
          {name}
        </span>
        {state.kind === "git" && (
          <>
            <span className="flex min-w-0 items-center gap-1 text-[11px] text-[var(--app-text-secondary)]">
              <GitBranch className="h-3 w-3 shrink-0 text-[var(--app-accent)]" />
              <span className="truncate" title={state.branch ?? undefined}>
                {state.branch}
              </span>
            </span>
            {state.changes.length > 0 && (
              <span
                className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums leading-none text-[var(--app-text-tertiary)]"
                style={{ background: "color-mix(in srgb, var(--app-text-primary) 8%, transparent)" }}
              >
                {state.changes.length}
              </span>
            )}
          </>
        )}
        {state.kind === "none" && (
          <span className="shrink-0 text-[11px] text-[var(--app-text-tertiary)]">
            {t("explorer.notGitRepo")}
          </span>
        )}
        {state.kind === "unavailable" && (
          <span className="shrink-0 text-[11px] text-[var(--app-text-tertiary)]">
            {t("explorer.gitUnavailable")}
          </span>
        )}
        <button
          type="button"
          aria-label={t("refresh")}
          title={t("refresh")}
          onClick={handleRefresh}
          className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[var(--app-text-tertiary)] opacity-0 transition-all duration-[var(--dur-fast)] group-hover/gitgroup:opacity-100 hover:bg-[var(--app-hover)] hover:text-[var(--app-accent)]"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>

      {/* 组体：变更文件列表（仅展开时渲染） */}
      {expanded && (
        <div className="flex flex-col pb-1 pl-3">
          {state.kind === "loading" ? (
            <div className="px-2 py-1.5 text-xs text-[var(--app-text-tertiary)]">
              {t("explorer.gitLoading")}
            </div>
          ) : state.kind === "none" ? (
            <div className="px-2 py-1.5 text-xs text-[var(--app-text-tertiary)]">
              {t("explorer.notGitRepo")}
            </div>
          ) : state.kind === "unavailable" ? (
            <div className="px-2 py-1.5 text-xs text-[var(--app-text-tertiary)]">
              {t("explorer.gitUnavailable")}
            </div>
          ) : state.changes.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-[var(--app-text-tertiary)]">
              {t("explorer.noChanges")}
            </div>
          ) : (
            state.changes.map(([filePath, status]) => {
              const badge = STATUS_BADGES[status];
              const relPath = toRelativePath(filePath, project.path);
              return (
                <div
                  key={filePath}
                  className="flex items-center gap-1.5 rounded px-2 py-1 text-xs hover:bg-[var(--app-hover)]"
                  title={relPath}
                >
                  <span
                    className={`w-3 shrink-0 text-center font-semibold ${badge?.className ?? "text-[var(--app-text-tertiary)]"}`}
                  >
                    {badge?.letter ?? "?"}
                  </span>
                  <span
                    className={`truncate text-[var(--app-text-secondary)] ${status === "deleted" ? "line-through" : ""}`}
                  >
                    {relPath}
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

interface ExplorerGitSectionProps {
  workspace: Workspace | null;
  selectedProjectId: string | null;
}

export default function ExplorerGitSection({
  workspace,
  selectedProjectId,
}: ExplorerGitSectionProps) {
  const { t } = useTranslation("sidebar");
  // 用户手动开合的覆盖项；选中项目/工作空间变化时清空，让新选中项目的组立即自动展开
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setOverrides({});
  }, [selectedProjectId, workspace?.id]);

  if (!workspace) {
    return (
      <div className="px-4 py-3 text-xs text-[var(--app-text-tertiary)]">
        {t("explorer.selectWorkspaceHint")}
      </div>
    );
  }

  if (workspace.projects.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-[var(--app-text-tertiary)]">
        {t("explorer.noProjects")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {workspace.projects.map((project) => {
        const expanded = overrides[project.id] ?? project.id === selectedProjectId;
        return (
          <GitProjectGroup
            key={project.id}
            project={project}
            expanded={expanded}
            onToggle={() =>
              setOverrides((prev) => ({ ...prev, [project.id]: !expanded }))
            }
          />
        );
      })}
    </div>
  );
}
