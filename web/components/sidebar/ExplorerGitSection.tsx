import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, GitBranch, RefreshCw } from "lucide-react";
import { gitService, type GitRepoInfo } from "@/services/gitService";
import { getProjectName } from "@/utils/path";
import type { Workspace, WorkspaceProject } from "@/types";

type GitProjectKind =
  | "loading"
  | "git"
  | "pathNotFound"
  | "notARepo"
  | "error"
  | "unavailable";

interface GitProjectState {
  kind: GitProjectKind;
  repoRoot: string | null;
  branch: string | null;
  hasChanges: boolean;
  changes: Array<[string, string]>;
  detailsLoading: boolean;
  detailError: string | null;
  message: string | null;
}

const LOADING_STATE: GitProjectState = {
  kind: "loading",
  repoRoot: null,
  branch: null,
  hasChanges: false,
  changes: [],
  detailsLoading: false,
  detailError: null,
  message: null,
};
const GIT_DETAIL_CONCURRENCY = 4;

type GitDetailLoader = <T>(task: () => Promise<T>) => Promise<T>;

function createDetailLimiter(maxConcurrent: number): GitDetailLoader {
  let active = 0;
  const queue: Array<() => void> = [];

  const acquire = () =>
    new Promise<void>((resolve) => {
      const start = () => {
        active += 1;
        resolve();
      };
      if (active < maxConcurrent) start();
      else queue.push(start);
    });

  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await task();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stateFromRepoInfo(info: GitRepoInfo): GitProjectState {
  if (info.state === "ok") {
    return {
      ...LOADING_STATE,
      kind: "git",
      repoRoot: info.repoRoot,
      branch: info.branch,
      hasChanges: info.hasChanges === true,
    };
  }
  const kind = info.state === "gitError" ? "error" : info.state;
  return { ...LOADING_STATE, kind, message: info.message ?? null };
}

/** 与 FileTreeNode 的 GIT_STATUS_COLORS 同源的状态配色 + 单字母标记 */
const STATUS_BADGES: Record<string, { letter: string; className: string }> = {
  modified: { letter: "M", className: "text-[var(--app-status-warning)]" },
  added: { letter: "A", className: "text-[var(--app-status-success)]" },
  deleted: { letter: "D", className: "text-[var(--app-status-danger)]" },
  untracked: { letter: "U", className: "text-[var(--app-status-success)]" },
  renamed: { letter: "R", className: "text-[var(--app-accent)]" },
  copied: { letter: "C", className: "text-[var(--app-accent)]" },
};

function toRelativePath(filePath: string, rootPath: string): string {
  const normalizedFile = filePath.replace(/\\/g, "/");
  const normalizedRoot = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalizedFile.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) {
    return normalizedFile.slice(normalizedRoot.length + 1);
  }
  return normalizedFile;
}

interface GitProjectGroupProps {
  project: WorkspaceProject;
  expanded: boolean;
  onToggle: () => void;
  loadDetails: GitDetailLoader;
}

function GitProjectGroup({ project, expanded, onToggle, loadDetails }: GitProjectGroupProps) {
  const { t } = useTranslation("sidebar");
  const [state, setState] = useState<GitProjectState>(LOADING_STATE);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ ...LOADING_STATE });
    gitService
      .getRepoInfo(project.path)
      .then((info) => {
        if (!cancelled) setState(stateFromRepoInfo(info));
      })
      .catch((error) => {
        if (!cancelled) {
          setState({ ...LOADING_STATE, kind: "unavailable", message: messageOf(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project.path, reloadTick]);

  useEffect(() => {
    if (!expanded || state.kind !== "git") return;
    let cancelled = false;
    setState((current) => ({ ...current, detailsLoading: true, detailError: null }));
    loadDetails(() => {
      if (cancelled) return Promise.resolve(null);
      return gitService.getFileStatuses(project.path);
    })
      .then((statuses) => {
        if (!cancelled && statuses) {
          setState((current) => ({
            ...current,
            changes: Object.entries(statuses).sort((a, b) => a[0].localeCompare(b[0])),
            detailsLoading: false,
          }));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState((current) => ({
            ...current,
            detailsLoading: false,
            detailError: messageOf(error),
          }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, loadDetails, project.path, reloadTick, state.kind]);

  const handleRefresh = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setReloadTick((tick) => tick + 1);
  }, []);

  const name = project.alias || getProjectName(project.path);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const stateHint = (() => {
    switch (state.kind) {
      case "pathNotFound":
        return t("explorer.gitPathNotFound");
      case "notARepo":
        return t("explorer.notGitRepo");
      case "error":
        return t("explorer.gitError", { message: state.message ?? t("explorer.gitUnknownError") });
      case "unavailable":
        return state.message
          ? t("explorer.gitUnavailableReason", { message: state.message })
          : t("explorer.gitUnavailable");
      default:
        return null;
    }
  })();

  return (
    <div className="flex flex-col">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") onToggle();
        }}
        className="group/gitgroup flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-[var(--app-hover)]"
        title={state.repoRoot ?? project.path}
      >
        <Chevron className="h-3 w-3 shrink-0 text-[var(--app-text-tertiary)]" />
        <span className="shrink-0 text-xs font-semibold text-[var(--app-text-primary)]">{name}</span>
        {state.kind === "git" && state.branch && (
          <span className="flex min-w-0 items-center gap-1 text-[11px] text-[var(--app-text-secondary)]">
            <GitBranch className="h-3 w-3 shrink-0 text-[var(--app-accent)]" />
            <span className="truncate" title={state.branch}>{state.branch}</span>
          </span>
        )}
        {state.kind === "git" && state.changes.length > 0 && (
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums leading-none text-[var(--app-text-tertiary)]"
            style={{ background: "color-mix(in srgb, var(--app-text-primary) 8%, transparent)" }}
          >
            {state.changes.length}
          </span>
        )}
        {stateHint && (
          <span className="min-w-0 truncate text-[11px] text-[var(--app-status-danger)]" title={stateHint}>
            {stateHint}
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

      {expanded && (
        <div className="flex flex-col pb-1 pl-3">
          {state.kind === "git" && state.repoRoot && state.repoRoot !== project.path && (
            <div className="truncate px-2 py-1 text-[11px] text-[var(--app-text-tertiary)]" title={state.repoRoot}>
              {t("explorer.gitRepoRoot", { path: state.repoRoot })}
            </div>
          )}
          {state.kind === "loading" ? (
            <div className="px-2 py-1.5 text-xs text-[var(--app-text-tertiary)]">{t("explorer.gitLoading")}</div>
          ) : stateHint ? (
            <div className="px-2 py-1.5 text-xs text-[var(--app-status-danger)]">{stateHint}</div>
          ) : state.detailsLoading ? (
            <div className="px-2 py-1.5 text-xs text-[var(--app-text-tertiary)]">{t("explorer.gitLoading")}</div>
          ) : state.detailError ? (
            <div className="px-2 py-1.5 text-xs text-[var(--app-status-danger)]">
              {t("explorer.gitError", { message: state.detailError })}
            </div>
          ) : state.changes.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-[var(--app-text-tertiary)]">{t("explorer.noChanges")}</div>
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
                  <span className={`w-3 shrink-0 text-center font-semibold ${badge?.className ?? "text-[var(--app-text-tertiary)]"}`}>
                    {badge?.letter ?? "?"}
                  </span>
                  <span className={`truncate text-[var(--app-text-secondary)] ${status === "deleted" ? "line-through" : ""}`}>
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

export default function ExplorerGitSection({ workspace, selectedProjectId }: ExplorerGitSectionProps) {
  const { t } = useTranslation("sidebar");
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const loadDetails = useMemo(
    () => createDetailLimiter(GIT_DETAIL_CONCURRENCY),
    [workspace?.id],
  );

  useEffect(() => {
    setOverrides({});
  }, [selectedProjectId, workspace?.id]);

  if (!workspace) {
    return <div className="px-4 py-3 text-xs text-[var(--app-text-tertiary)]">{t("explorer.selectWorkspaceHint")}</div>;
  }
  if (workspace.projects.length === 0) {
    return <div className="px-4 py-3 text-xs text-[var(--app-text-tertiary)]">{t("explorer.noProjects")}</div>;
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
            loadDetails={loadDetails}
            onToggle={() => setOverrides((current) => ({ ...current, [project.id]: !expanded }))}
          />
        );
      })}
    </div>
  );
}
