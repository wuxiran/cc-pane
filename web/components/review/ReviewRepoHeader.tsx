// 多仓库审阅时每个仓库前的分组头：仓库名、分支、文件数、增删行数。
import { GitBranch } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ReviewFile, ReviewRepo } from "./reviewData";

/** 多仓库时同名文件会重复，折叠状态和 React key 都要带上仓库。 */
export function fileKey(file: ReviewFile): string {
  return `${file.repoRoot ?? ""}::${file.path}`;
}

export default function ReviewRepoHeader({ repos, files, repoRoot }: {
  repos: readonly ReviewRepo[]; files: readonly ReviewFile[]; repoRoot: string | undefined;
}) {
  const { t } = useTranslation("review");
  const repo = repos.find((item) => item.root === repoRoot);
  const own = files.filter((file) => file.repoRoot === repoRoot);
  const additions = own.reduce((sum, file) => sum + (file.diff?.stats.additions ?? 0), 0);
  const deletions = own.reduce((sum, file) => sum + (file.diff?.stats.deletions ?? 0), 0);
  return <div className="flex min-w-0 items-center gap-2 pt-2 text-sm" data-review-repo={repoRoot}>
    <GitBranch className="size-4 shrink-0 text-[var(--app-text-tertiary)]" />
    <span className="truncate font-medium text-[var(--app-text-primary)]" title={repoRoot}>{repo?.label ?? repoRoot}</span>
    {repo?.branch && <span className="shrink-0 text-xs text-[var(--app-text-tertiary)]">{repo.branch}</span>}
    <span className="shrink-0 text-xs text-[var(--app-text-tertiary)]">{t("files", { count: own.length })}</span>
    <span className="flex shrink-0 gap-2 font-mono text-xs tabular-nums">
      <span className="text-[var(--app-status-success)]">+{additions}</span>
      <span className="text-[var(--app-status-danger)]">-{deletions}</span>
    </span>
  </div>;
}
