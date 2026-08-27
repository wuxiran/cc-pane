import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Plus } from "lucide-react";
import { useLayoutUiStore } from "@/stores/useLayoutUiStore";
import type { WorktreeInfo } from "@/services";
import type {
  Workspace, WorkspaceProject, OpenTerminalOptions, PathStatusKind,
} from "@/types";
import { normalizeWorkspaceProjects } from "./workspaceProjects";
import { buildProjectTree, type WorktreeGroup } from "./worktreeGrouping";
import { sidebarEntityBadgeClass } from "./sidebarStyles";
import ProjectListItem from "./ProjectListItem";

interface ProjectListViewProps {
  projects: WorkspaceProject[];
  ws: Workspace;
  gitBranches: Record<string, string | null>;
  /** 按 project.path 索引的 `git worktree list` 结果，用于派生 worktree 归属 */
  worktreeCache?: Record<string, WorktreeInfo[]>;
  /** 按 project.id 索引的路径存在性判定 */
  projectPathStatus?: Record<string, PathStatusKind>;
  /** 已安装或显式配置的 CLI；undefined 表示环境探测尚未完成。 */
  availableCliToolIds?: ReadonlySet<string>;
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
  onRemoveProject: (ws: Workspace, project: WorkspaceProject) => void;
  onSetProjectAlias: (ws: Workspace, project: WorkspaceProject) => void;
  onImportProject: (ws: Workspace) => void;
  onMigrateProject: (ws: Workspace, project: WorkspaceProject) => void;
  onOpenWorktreeManager: (project: WorkspaceProject, ws: Workspace) => void;
  onOpenInFileBrowser?: (path: string) => void;
  onCleanupMissingProjects?: (ws: Workspace) => void;
}

const EMPTY_WORKTREE_CACHE: Record<string, WorktreeInfo[]> = {};
const EMPTY_PATH_STATUS: Record<string, PathStatusKind> = {};

export default function ProjectListView({
  projects, ws, gitBranches,
  worktreeCache = EMPTY_WORKTREE_CACHE,
  projectPathStatus = EMPTY_PATH_STATUS,
  availableCliToolIds,
  onOpenTerminal, onRemoveProject, onSetProjectAlias,
  onImportProject, onMigrateProject, onOpenWorktreeManager, onOpenInFileBrowser,
  onCleanupMissingProjects,
}: ProjectListViewProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const expandedWorktreeGroups = useLayoutUiStore((s) => s.expandedWorktreeGroups);
  const toggleWorktreeGroup = useLayoutUiStore((s) => s.toggleWorktreeGroup);

  const safeProjects = normalizeWorkspaceProjects(projects);
  const invalidProjectCount = Array.isArray(projects)
    ? projects.length - safeProjects.length
    : 0;
  const workspace = safeProjects === projects ? ws : { ...ws, projects: safeProjects };

  const tree = useMemo(
    () => buildProjectTree(safeProjects, worktreeCache),
    [safeProjects, worktreeCache],
  );
  const expandedSet = useMemo(
    () => new Set(expandedWorktreeGroups),
    [expandedWorktreeGroups],
  );
  const missingCount = useMemo(
    () => safeProjects.filter((p) => projectPathStatus[p.id] === "missing").length,
    [safeProjects, projectPathStatus],
  );

  const renderItem = (
    project: WorkspaceProject,
    extra?: { worktreeBranch?: string; leading?: React.ReactNode; trailing?: React.ReactNode },
  ) => (
    <ProjectListItem
      key={project.id}
      project={project}
      workspace={workspace}
      gitBranch={gitBranches[project.path]}
      pathStatus={projectPathStatus[project.id]}
      worktreeBranch={extra?.worktreeBranch}
      leading={extra?.leading}
      trailing={extra?.trailing}
      onOpenTerminal={onOpenTerminal}
      onRemoveProject={onRemoveProject}
      onSetProjectAlias={onSetProjectAlias}
      onMigrateProject={onMigrateProject}
      onOpenWorktreeManager={onOpenWorktreeManager}
      onOpenInFileBrowser={onOpenInFileBrowser}
      availableCliToolIds={availableCliToolIds}
    />
  );

  const renderGroup = (group: WorktreeGroup) => {
    const open = expandedSet.has(group.repoKey);
    const chevron = (
      <button
        type="button"
        aria-label={t("worktreeGroupToggle")}
        aria-expanded={open}
        className="shrink-0 -ml-1 p-0.5 rounded hover:bg-[var(--app-active-bg)]"
        onClick={(e) => {
          e.stopPropagation();
          toggleWorktreeGroup(group.repoKey);
        }}
      >
        <ChevronRight
          size={13}
          className={`transition-transform duration-[var(--dur-fast)] ${
            open ? "rotate-90 text-[var(--app-accent)]" : "text-[var(--app-text-tertiary)]"
          }`}
        />
      </button>
    );
    const count = (
      <span
        className={`${sidebarEntityBadgeClass} tabular-nums text-[var(--app-text-tertiary)] bg-[color-mix(in_srgb,var(--app-text-primary)_8%,transparent)]`}
        aria-label={t("worktreeGroupCount", { count: group.children.length })}
      >
        {group.children.length}
      </span>
    );

    return (
      <div key={group.repoKey}>
        {renderItem(group.parent, { leading: chevron, trailing: count })}
        {open ? (
          <div className="relative flex flex-col gap-1 pl-4">
            <span
              aria-hidden="true"
              className="absolute left-[9px] top-0.5 bottom-0.5 w-px bg-[var(--app-border)]"
            />
            {group.children.map((child) =>
              renderItem(child.project, { worktreeBranch: child.branch })
            )}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-0.5 px-0 pb-2 pt-1">
      {invalidProjectCount > 0 ? (
        <div className="rounded-lg border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-bg)] px-2 py-1.5 text-[11px] text-[var(--app-status-warning)]">
          {t("invalidProjectsSkipped", {
            count: invalidProjectCount,
            defaultValue: `已隐藏 ${invalidProjectCount} 个异常项目`,
          })}
        </div>
      ) : null}
      {missingCount > 0 && onCleanupMissingProjects ? (
        <div className="flex items-center gap-2 rounded-lg border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-bg)] px-2 py-1.5 text-[11px] text-[var(--app-status-warning)]">
          <span className="flex-1">
            {t("missingProjectsBanner", { count: missingCount })}
          </span>
          <button
            type="button"
            className="shrink-0 rounded px-2 py-0.5 font-medium underline-offset-2 hover:underline"
            onClick={() => onCleanupMissingProjects(workspace)}
          >
            {t("missingProjectsCleanup")}
          </button>
        </div>
      ) : null}

      {tree.map((node) =>
        node.kind === "group" ? renderGroup(node.group) : renderItem(node.project)
      )}

      {/* 导入项目按钮 */}
      <div
        className="flex items-center justify-center gap-1 p-1.5 mt-1 text-[11px] rounded-lg cursor-pointer transition-colors duration-[var(--dur-fast)] border border-dashed group border-[var(--app-border)] text-[var(--app-text-tertiary)] hover:border-[var(--app-accent)] hover:text-[var(--app-accent)] hover:bg-[var(--app-active-bg)]"
        onClick={() => onImportProject(workspace)}
      >
        <Plus size={12} className="transition-transform group-hover:rotate-90" />
        <span>{t("importProject")}</span>
      </div>
    </div>
  );
}
