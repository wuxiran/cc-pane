import { computeTextDiff } from "@/services/agentChatService";
import { filesystemService } from "@/services/filesystemService";
import { gitService, type GitChangedFile } from "@/services/gitService";
import type { DiffResult } from "@/services/localHistoryService";
import { turnCheckpointService } from "@/services/turnCheckpointService";

export type ReviewScope = "turn" | "workspace" | "branch";
export interface ReviewFile {
  path: string;
  oldPath?: string | null;
  status: string;
  canOpen: boolean;
  previewOmitted?: boolean;
  diff?: DiffResult;
  error?: string;
  /** 多仓库审阅时这个文件属于哪个仓库（根目录）；单仓库时省略 */
  repoRoot?: string;
}

/** 审阅范围内找到的一个 Git 仓库。 */
export interface ReviewRepo {
  root: string;
  label: string;
  branch: string | null;
}
export interface ReviewSource {
  root: string;
  files: ReviewFile[];
  notice?: string | null;
  baseCommit?: string;
  headCommit?: string;
  readDiff: (index: number) => Promise<DiffResult | undefined>;
}

const MAX_CHILD_SCAN = 60;
const trimSlash = (path: string) => path.replace(/[\\/]+$/, "");
const baseName = (path: string) => trimSlash(path).split(/[\\/]/).pop() || path;

/**
 * 找出审阅范围内的 Git 仓库：打开的目录本身、所属工作空间登记的项目；打开的目录不是仓库时，
 * 再看它的直接子目录（工作空间根目录下放着几个项目的常见布局）。按仓库根去重。
 */
export async function resolveReviewRepos(path: string, projectPaths: readonly string[]): Promise<ReviewRepo[]> {
  const candidates = new Set([trimSlash(path), ...projectPaths.map(trimSlash)]);
  const self = await gitService.getRepoInfo(path).catch(() => null);
  if (self?.state !== "ok") {
    const listing = await filesystemService.listDirectory(path, false).catch(() => null);
    listing?.entries.filter((entry) => entry.isDir && !entry.hidden).slice(0, MAX_CHILD_SCAN)
      .forEach((entry) => candidates.add(trimSlash(entry.path)));
  }
  const infos = await Promise.all([...candidates].map((candidate) =>
    candidate === trimSlash(path) && self ? Promise.resolve(self) : gitService.getRepoInfo(candidate).catch(() => null)));
  const repos = new Map<string, ReviewRepo>();
  for (const info of infos) {
    if (info?.state !== "ok" || !info.repoRoot) continue;
    const root = trimSlash(info.repoRoot);
    if (!repos.has(root)) repos.set(root, { root, label: baseName(root), branch: info.branch ?? null });
  }
  return [...repos.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** 工作区改动跨多个仓库：每个仓库各查一次，文件带上所属仓库，diff 按各自仓库读。 */
export async function loadMultiRepoWorkspaceSource(rootLabel: string, repos: readonly ReviewRepo[]): Promise<ReviewSource> {
  const perRepo = await Promise.all(repos.map(async (repo) => ({
    repo, files: await gitService.getChangedFiles(repo.root).catch(() => [] as GitChangedFile[]),
  })));
  const entries = perRepo.flatMap(({ repo, files }) => files.map((file) => ({ repo, file })));
  return {
    root: rootLabel,
    files: entries.map(({ repo, file }) => ({ path: file.newPath ?? file.oldPath ?? "", oldPath: file.oldPath,
      status: file.status, canOpen: file.newPath !== null, repoRoot: repo.root })),
    readDiff: (index) => gitService.getDiff(entries[index].repo.root, { mode: "worktreeVsHead", file: entries[index].file }),
  };
}

/** Frozen commits for branch review; repository snapshots for a completed turn. */
export async function loadReviewSource(path: string, scope: ReviewScope, checkpointId: string, baseRef: string): Promise<ReviewSource> {
  if (scope === "turn") {
    const review = await turnCheckpointService.review(checkpointId);
    return {
      root: review.record.cwd,
      notice: review.record.unavailableReason ?? ((!review.record.before || !review.record.after) ? review.blockedReason : null),
      files: review.files.map((file) => ({ path: file.path, status: file.status,
        canOpen: file.status !== "deleted", previewOmitted: file.previewOmitted })),
      readDiff: async (index) => {
        const file = review.files[index];
        return file.previewOmitted ? undefined : computeTextDiff(file.beforeContent ?? "", file.afterContent ?? "");
      },
    };
  }
  const repo = await gitService.getRepoInfo(path);
  if (repo.state !== "ok" || !repo.repoRoot) throw new Error(repo.message || `Git repository unavailable: ${repo.state}`);
  const branch = scope === "branch" ? await gitService.getBranchReview(path, baseRef) : null;
  const files: GitChangedFile[] = branch?.files ?? await gitService.getChangedFiles(path);
  return {
    root: repo.repoRoot, baseCommit: branch?.baseCommit, headCommit: branch?.headCommit,
    files: files.map((file) => ({ path: file.newPath ?? file.oldPath ?? "", oldPath: file.oldPath,
      status: file.status, canOpen: file.newPath !== null })),
    readDiff: (index) => gitService.getDiff(path, branch
      ? { mode: "commitVsCommit", oldRev: branch.baseCommit, newRev: branch.headCommit, file: files[index] }
      : { mode: "worktreeVsHead", file: files[index] }),
  };
}

/** Joining a backend-returned repository path never grants traversal to the editor. */
export function reviewFilePath(root: string, relative: string): string | null {
  if (!relative || /^[\\/]|^[A-Za-z]:/.test(relative) || relative.split(/[\\/]/).some((part) => part === "..")) return null;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${relative}`;
}
