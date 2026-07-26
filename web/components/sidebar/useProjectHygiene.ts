import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useWorkspacesStore } from "@/stores";
import { checkWorkspaceProjectPaths } from "@/services/workspaceService";
import { projectPathsEquivalent } from "@/utils/projectIdentity";
import type { PathStatusKind, ProjectPathStatus, Workspace } from "@/types";

type RemoveProject = (workspaceName: string, projectId: string) => Promise<void>;

interface UseProjectHygieneParams {
  expandedWorkspace: Workspace | undefined;
  removeProject: RemoveProject;
}

/**
 * 项目记录卫生：路径存在性判定 + 失效记录批量清理 + worktree 删除联动。
 *
 * 存在的理由是一条单向流：worktree 的创建会自动注册 Project，而删除只跑 git
 * （`remove_worktree` 不碰 workspace.json），记录于是只增不减。这里补上标记与回收。
 * **任何操作都只移除工作空间记录，绝不触碰磁盘。**
 */
export function useProjectHygiene({
  expandedWorkspace, removeProject,
}: UseProjectHygieneParams) {
  const { t: tNotify } = useTranslation("notifications");
  const [pathStatusByWorkspace, setPathStatusByWorkspace] =
    useState<Record<string, ProjectPathStatus[]>>({});
  const requestedPathStatus = useRef(new Set<string>());
  const [missingCleanupOpen, setMissingCleanupOpen] = useState(false);
  const [missingCleanupWorkspace, setMissingCleanupWorkspace] = useState<Workspace | null>(null);

  const refreshProjectPathStatus = useCallback(async (workspaceName: string) => {
    try {
      const statuses = await checkWorkspaceProjectPaths(workspaceName);
      if (!Array.isArray(statuses)) return;
      setPathStatusByWorkspace((prev) => ({ ...prev, [workspaceName]: statuses }));
    } catch {
      // 探测失败静默：绝不能因为一次 IPC 失败就把项目标红或隐藏
    }
  }, []);

  const dropPathStatus = useCallback((workspaceName: string, projectIds: string[]) => {
    setPathStatusByWorkspace((prev) => {
      const current = prev[workspaceName];
      if (!current) return prev;
      const removed = new Set(projectIds);
      return { ...prev, [workspaceName]: current.filter((s) => !removed.has(s.projectId)) };
    });
  }, []);

  const projectPathStatus = useMemo(() => {
    const map: Record<string, PathStatusKind> = {};
    for (const statuses of Object.values(pathStatusByWorkspace)) {
      for (const status of statuses ?? []) map[status.projectId] = status.status;
    }
    return map;
  }, [pathStatusByWorkspace]);

  useEffect(() => {
    if (!expandedWorkspace) return;
    if (requestedPathStatus.current.has(expandedWorkspace.name)) return;
    requestedPathStatus.current.add(expandedWorkspace.name);
    void refreshProjectPathStatus(expandedWorkspace.name);
  }, [expandedWorkspace, refreshProjectPathStatus]);

  const handleCleanupMissingProjects = useCallback((ws: Workspace) => {
    setMissingCleanupWorkspace(ws);
    setMissingCleanupOpen(true);
    void refreshProjectPathStatus(ws.name);
  }, [refreshProjectPathStatus]);

  const confirmCleanupMissingProjects = useCallback(async (projectIds: string[]) => {
    const ws = missingCleanupWorkspace;
    if (!ws || projectIds.length === 0) return;
    let failed = 0;
    const removedIds: string[] = [];
    for (const projectId of projectIds) {
      try {
        await removeProject(ws.name, projectId);
        removedIds.push(projectId);
      } catch {
        failed++;
      }
    }
    dropPathStatus(ws.name, removedIds);
    if (failed > 0) {
      toast.warning(tNotify("missingProjectsPartialFailure", {
        removed: removedIds.length, failed,
      }));
    } else if (removedIds.length > 0) {
      toast.success(tNotify("missingProjectsRemoved", { count: removedIds.length }));
    }
  }, [missingCleanupWorkspace, removeProject, dropPathStatus, tNotify]);

  /**
   * worktree 被删除后，同步移除工作空间里对应的项目记录。
   * 遍历全部工作空间——worktree 可能被导入到与主仓库不同的工作空间。
   */
  const handleWorktreeRemoved = useCallback(async (worktreePath: string) => {
    let removed = 0;
    let failed = 0;
    for (const ws of useWorkspacesStore.getState().workspaces) {
      const matches = (Array.isArray(ws.projects) ? ws.projects : []).filter(
        (project) => !project?.ssh
          && typeof project?.path === "string"
          && projectPathsEquivalent(project.path, worktreePath),
      );
      for (const project of matches) {
        try {
          await removeProject(ws.name, project.id);
          removed++;
        } catch {
          failed++;
        }
      }
    }
    if (failed > 0) {
      toast.warning(tNotify("worktreeProjectRecordRemoveFailed"));
    } else if (removed > 0) {
      toast.success(tNotify("worktreeProjectRecordRemoved"));
    }
  }, [removeProject, tNotify]);

  return {
    projectPathStatus,
    refreshProjectPathStatus,
    handleCleanupMissingProjects,
    handleWorktreeRemoved,
    missingProjectsDialog: {
      open: missingCleanupOpen,
      setOpen: setMissingCleanupOpen,
      workspace: missingCleanupWorkspace,
      statuses: missingCleanupWorkspace
        ? pathStatusByWorkspace[missingCleanupWorkspace.name] ?? []
        : [],
      onConfirm: confirmCleanupMissingProjects,
    },
  };
}
