// 工作空间根目录本身不是 Git 仓库时，找出其下哪些项目是 Git 仓库（带当前分支），
// 供「在新 worktree 中启动」选择目标项目。
import { useEffect, useState } from "react";
import { gitService } from "@/services/gitService";
import { handleErrorSilent } from "@/utils/errorHandler";

export interface WorkspaceProjectCandidate {
  path: string;
  name: string;
}

export interface WorkspaceGitProject extends WorkspaceProjectCandidate {
  branch: string | null;
}

/**
 * active=false 或没有候选时返回 []；检测中返回 null。
 * refresh 变化时重测（弹层每次打开刷新分支）。
 */
export function useWorkspaceGitProjects(
  candidates: WorkspaceProjectCandidate[] | undefined,
  active: boolean,
  refresh?: unknown,
): WorkspaceGitProject[] | null {
  const key = active && candidates?.length
    ? JSON.stringify(candidates.map((candidate) => [candidate.path, candidate.name]))
    : "";
  const [result, setResult] = useState<{ key: string; projects: WorkspaceGitProject[] } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const entries = JSON.parse(key) as [string, string][];
    void Promise.all(entries.map(async ([path, name]): Promise<WorkspaceGitProject | null> => {
      try {
        const info = await gitService.getRepoInfo(path);
        return info.state === "ok" ? { path, name, branch: info.branch } : null;
      } catch (error) {
        // 读不到的项目只是不能当 worktree 目标，不影响其他项目。
        handleErrorSilent(error, "probe workspace project git info");
        return null;
      }
    })).then((projects) => {
      if (!cancelled) {
        setResult({ key, projects: projects.filter((project): project is WorkspaceGitProject => project !== null) });
      }
    });
    return () => { cancelled = true; };
  }, [key, refresh]);
  if (!key) return [];
  return result?.key === key ? result.projects : null;
}
