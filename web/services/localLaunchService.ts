import i18n from "@/i18n";
import type { LocalWorktreeDraft } from "@/types/localLaunch";
import { worktreeService } from "./worktreeService";

export function newSessionBranch(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
  return `cc/${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Only creates an isolated checkout. The original directory and branch are untouched. */
export async function prepareLocalSessionCwd(
  cwd: string,
  worktree?: LocalWorktreeDraft,
): Promise<string> {
  if (!worktree?.enabled) return cwd;
  const branch = worktree.branch.trim();
  const baseRef = worktree.baseRef?.trim() || "HEAD";
  if (!branch) throw new Error(i18n.t("worktreeBranchRequired", { ns: "launcher" }));
  const name = branch.replace(/[^\p{L}\p{N}_.-]+/gu, "-").replace(/^-+|-+$/g, "") || "cc-worktree";
  return worktreeService.add(cwd, name, branch, baseRef, true);
}
