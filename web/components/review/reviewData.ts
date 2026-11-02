import { computeTextDiff } from "@/services/agentChatService";
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
}
export interface ReviewSource {
  root: string;
  files: ReviewFile[];
  notice?: string | null;
  baseCommit?: string;
  headCommit?: string;
  readDiff: (index: number) => Promise<DiffResult | undefined>;
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
