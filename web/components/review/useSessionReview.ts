import { useCallback, useEffect, useState } from "react";
import { gitService } from "@/services/gitService";
import { turnCheckpointService } from "@/services/turnCheckpointService";
import type { TurnCheckpointRecord } from "@/types/turnCheckpoint";
import { getErrorMessage } from "@/utils";
import { useWorkspacesStore } from "@/stores";
import type { Workspace } from "@/types";
import {
  loadMultiRepoWorkspaceSource, loadReviewSource, resolveReviewRepos,
  type ReviewFile, type ReviewRepo, type ReviewScope,
} from "./reviewData";

const norm = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const within = (child: string, parent: string) => child === parent || child.startsWith(`${parent}/`);

/** 打开的目录所属工作空间登记的本机项目（含工作空间根在这个目录里、或项目就是它的情况）。 */
function workspaceProjectPaths(workspaces: readonly Workspace[], path: string): string[] {
  const target = norm(path);
  const paths: string[] = [];
  for (const workspace of workspaces) {
    const locals = workspace.projects.filter((project) => !project.ssh && project.path);
    const owns = (workspace.path && within(target, norm(workspace.path)))
      || locals.some((project) => within(target, norm(project.path)) || within(norm(project.path), target));
    if (owns) paths.push(...locals.map((project) => project.path));
  }
  return paths;
}

export function useSessionReview(projectPath: string, chatId: string | undefined, open: boolean, noRepoMessage: string) {
  const [scope, setScope] = useState<ReviewScope>("workspace");
  const [baseRef, setBaseRef] = useState("");
  const [checkpointId, selectCheckpoint] = useState("");
  const [records, setRecords] = useState<TurnCheckpointRecord[]>([]);
  const [files, setFiles] = useState<ReviewFile[]>([]);
  const [root, setRoot] = useState(projectPath);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [range, setRange] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  // null = 还在找仓库；repoFilter 空串 = 全部仓库
  const [repos, setRepos] = useState<ReviewRepo[] | null>(null);
  const [repoFilter, setRepoFilter] = useState("");
  const reload = useCallback(() => setRefresh((value) => value + 1), []);

  useEffect(() => {
    selectCheckpoint(""); setRecords([]); setFiles([]); setError(null); setCheckpointError(null);
    setBaseRef(""); setScope("workspace"); setNotice(null); setRange(null); setBranches([]); setBranchError(null); setRecordsLoading(false); setBranchesLoading(false);
    setRepos(null); setRepoFilter("");
  }, [projectPath, chatId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const projects = workspaceProjectPaths(useWorkspacesStore.getState().workspaces, projectPath);
    void resolveReviewRepos(projectPath, projects)
      .then((found) => { if (!cancelled) setRepos(found); })
      .catch(() => { if (!cancelled) setRepos([]); });
    return () => { cancelled = true; };
  }, [projectPath, open, refresh]);

  // 实际要查的单个仓库：手选的、或只有一个仓库时就是它；多仓库「全部」时为 null。
  // 分支对比只能对一个仓库做：多仓库且没选时取第一个。
  const multi = (repos?.length ?? 0) > 1;
  const singleRepo = repoFilter
    || (repos?.length === 1 ? repos[0].root : null)
    || (scope === "branch" && multi ? repos![0].root : null);
  const gitPath = singleRepo ?? projectPath;

  useEffect(() => {
    if (!open || scope !== "branch") return;
    let cancelled = false;
    setBranchesLoading(true); setBranchError(null);
    void Promise.all([gitService.getLocalBranches(gitPath), gitService.getRepoInfo(gitPath)]).then(([items, repo]) => {
      if (cancelled) return;
      setBranches(items);
      const preferred = ["main", "master"].find((branch) => branch !== repo.branch && items.includes(branch));
      if (preferred) setBaseRef((previous) => previous || preferred);
    }).catch((cause) => { if (!cancelled) setBranchError(getErrorMessage(cause)); })
      .finally(() => { if (!cancelled) setBranchesLoading(false); });
    return () => { cancelled = true; };
  }, [gitPath, scope, open]);

  useEffect(() => {
    if (!open || !chatId) return;
    let cancelled = false;
    setRecordsLoading(true); setCheckpointError(null);
    void turnCheckpointService.list(chatId).then((items) => {
      if (cancelled) return;
      setRecords(items);
      selectCheckpoint((previous) => items.some((record) => record.id === previous && record.completedAt)
        ? previous : items.find((record) => record.completedAt)?.id ?? "");
    }).catch((cause) => { if (!cancelled) { setRecords([]); setCheckpointError(getErrorMessage(cause)); } })
      .finally(() => { if (!cancelled) setRecordsLoading(false); });
    return () => { cancelled = true; };
  }, [projectPath, chatId, open, refresh]);

  useEffect(() => {
    let cancelled = false;
    setFiles([]); setError(null); setNotice(null); setRange(null); setRoot(projectPath);
    if (!open || repos === null || (scope === "turn" && !checkpointId) || (scope === "branch" && !baseRef)) {
      setLoading(open && repos === null); return;
    }
    setLoading(true);
    const load = scope === "workspace" && multi && !singleRepo
      ? loadMultiRepoWorkspaceSource(projectPath, repos)
      : scope !== "turn" && repos.length === 0
        ? Promise.reject(new Error(noRepoMessage))
        : loadReviewSource(scope === "turn" ? projectPath : gitPath, scope, checkpointId, baseRef);
    void load.then(async (source) => {
      if (cancelled) return;
      setRoot(source.root); setNotice(source.notice ?? null);
      setRange(source.baseCommit && source.headCommit ? `${source.baseCommit.slice(0, 8)} → ${source.headCommit.slice(0, 8)}` : null);
      setFiles(source.files);
      let next = 0;
      // Bound concurrent IPC work; obsolete requests cannot paint another scope/session.
      const worker = async () => {
        while (!cancelled && next < source.files.length) {
          const index = next++;
          let patch: Partial<ReviewFile>;
          try { patch = { diff: await source.readDiff(index) }; }
          catch (cause) { patch = { error: getErrorMessage(cause) }; }
          if (!cancelled) setFiles((current) => current.map((file, i) => i === index ? { ...file, ...patch } : file));
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, source.files.length) }, worker));
    }).catch((cause) => { if (!cancelled) setError(getErrorMessage(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectPath, gitPath, repos, multi, singleRepo, noRepoMessage, open, scope, checkpointId, baseRef, refresh]);

  return { repos: repos ?? [], repoFilter, setRepoFilter, multiRepo: multi && !singleRepo, scope, setScope, baseRef, setBaseRef, checkpointId, selectCheckpoint, records, files,
    root, notice, error, checkpointError, loading, recordsLoading, range, branches, branchError, branchesLoading, reload };
}
