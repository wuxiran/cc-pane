import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileDiff, GitCommitHorizontal, History, LoaderCircle } from "lucide-react";
import DiffView from "@/components/DiffView";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  gitService,
  type GitChangedFile,
  type GitCommit,
} from "@/services/gitService";
import type { DiffResult } from "@/services/localHistoryService";

interface GitTimelinePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string;
  initialFile: GitChangedFile | null;
}

type DiffTarget =
  | { kind: "worktree"; file: GitChangedFile }
  | { kind: "commit"; commit: GitCommit; parentIndex: number; file: GitChangedFile };

const PAGE_SIZE = 50;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function filePath(file: GitChangedFile): string {
  if (file.oldPath && file.newPath && file.oldPath !== file.newPath) {
    return `${file.oldPath} -> ${file.newPath}`;
  }
  return file.newPath ?? file.oldPath ?? "";
}

function statusLetter(file: GitChangedFile): string {
  const letters: Record<GitChangedFile["status"], string> = {
    modified: "M",
    added: "A",
    deleted: "D",
    untracked: "U",
    renamed: "R",
    copied: "C",
    typeChanged: "T",
    conflicted: "!",
  };
  return letters[file.status];
}

function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function GitTimelinePanel({
  open,
  onOpenChange,
  projectPath,
  initialFile,
}: GitTimelinePanelProps) {
  const { t } = useTranslation("dialogs");
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState("");
  const [branchesReady, setBranchesReady] = useState(false);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<GitCommit | null>(null);
  const [parentIndex, setParentIndex] = useState(0);
  const [files, setFiles] = useState<GitChangedFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const metadataRequestId = useRef(0);
  const logRequestId = useRef(0);
  const filesRequestId = useRef(0);
  const diffRequestId = useRef(0);

  useEffect(() => {
    if (!open || !projectPath) return;
    const requestId = ++metadataRequestId.current;
    setBranches([]);
    setBranch("");
    setBranchesReady(false);
    setCommits([]);
    setLogLoading(false);
    setSelectedCommit(null);
    setParentIndex(0);
    setFiles([]);
    setFilesLoading(false);
    setDiffTarget(initialFile ? { kind: "worktree", file: initialFile } : null);
    setDiff(null);
    setDiffLoading(false);
    setLogError(null);
    setFilesError(null);
    setDiffError(null);

    Promise.all([gitService.getLocalBranches(projectPath), gitService.getRepoInfo(projectPath)])
      .then(([localBranches, repoInfo]) => {
        if (metadataRequestId.current !== requestId) return;
        setBranches(localBranches);
        setBranch(
          repoInfo.branch && localBranches.includes(repoInfo.branch)
            ? repoInfo.branch
            : (localBranches[0] ?? ""),
        );
        setBranchesReady(true);
      })
      .catch((error) => {
        if (metadataRequestId.current !== requestId) return;
        setLogError(messageOf(error));
        setBranchesReady(true);
      });
    return () => {
      if (metadataRequestId.current === requestId) metadataRequestId.current += 1;
    };
  }, [initialFile, open, projectPath]);

  useEffect(() => {
    if (!open || !projectPath || !branchesReady) return;
    const requestId = ++logRequestId.current;
    setLogLoading(true);
    setLogError(null);
    setCommits([]);
    setHasMore(false);
    setNextOffset(null);
    setSelectedCommit(null);
    setFiles([]);
    if (!initialFile) {
      setDiffTarget(null);
      setDiff(null);
    }
    gitService
      .getLog(projectPath, {
        limit: PAGE_SIZE,
        offset: 0,
        branch: branch || undefined,
      })
      .then((page) => {
        if (logRequestId.current !== requestId) return;
        setCommits(page.commits);
        setHasMore(page.hasMore);
        setNextOffset(page.nextOffset);
        setLogLoading(false);
      })
      .catch((error) => {
        if (logRequestId.current !== requestId) return;
        setLogError(messageOf(error));
        setLogLoading(false);
      });
    return () => {
      logRequestId.current += 1;
    };
  }, [branch, branchesReady, initialFile, open, projectPath]);

  useEffect(() => {
    if (!open || !selectedCommit) return;
    const requestId = ++filesRequestId.current;
    setFilesLoading(true);
    setFilesError(null);
    setFiles([]);
    setDiffTarget(null);
    setDiff(null);
    gitService
      .listCommitFiles(projectPath, selectedCommit.hash, parentIndex)
      .then((nextFiles) => {
        if (filesRequestId.current !== requestId) return;
        setFiles(nextFiles);
        setFilesLoading(false);
      })
      .catch((error) => {
        if (filesRequestId.current !== requestId) return;
        setFilesError(messageOf(error));
        setFilesLoading(false);
      });
    return () => {
      if (filesRequestId.current === requestId) filesRequestId.current += 1;
    };
  }, [open, parentIndex, projectPath, selectedCommit]);

  useEffect(() => {
    if (!open || !diffTarget) return;
    const requestId = ++diffRequestId.current;
    setDiffLoading(true);
    setDiffError(null);
    setDiff(null);
    const spec = diffTarget.kind === "worktree"
      ? { mode: "worktreeVsHead" as const, file: diffTarget.file }
      : {
          mode: "commitVsParent" as const,
          commit: diffTarget.commit.hash,
          parentIndex: diffTarget.parentIndex,
          file: diffTarget.file,
        };
    gitService
      .getDiff(projectPath, spec)
      .then((result) => {
        if (diffRequestId.current !== requestId) return;
        setDiff(result);
        setDiffLoading(false);
      })
      .catch((error) => {
        if (diffRequestId.current !== requestId) return;
        setDiffError(messageOf(error));
        setDiffLoading(false);
      });
    return () => {
      if (diffRequestId.current === requestId) diffRequestId.current += 1;
    };
  }, [diffTarget, open, projectPath]);

  const loadMore = () => {
    if (logLoading || nextOffset === null) return;
    const requestId = ++logRequestId.current;
    setLogLoading(true);
    gitService
      .getLog(projectPath, {
        limit: PAGE_SIZE,
        offset: nextOffset,
        branch: branch || undefined,
      })
      .then((page) => {
        if (logRequestId.current !== requestId) return;
        setCommits((current) => [...current, ...page.commits]);
        setHasMore(page.hasMore);
        setNextOffset(page.nextOffset);
        setLogLoading(false);
      })
      .catch((error) => {
        if (logRequestId.current !== requestId) return;
        setLogError(messageOf(error));
        setLogLoading(false);
      });
  };

  const chooseCommit = (commit: GitCommit) => {
    setParentIndex(0);
    setSelectedCommit(commit);
  };

  const chooseFile = (file: GitChangedFile) => {
    if (!selectedCommit) return;
    setDiffTarget({ kind: "commit", commit: selectedCommit, parentIndex, file });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(86vh,900px)] w-[calc(100vw-1.5rem)] max-w-none gap-0 overflow-hidden p-0 sm:max-w-[1200px]">
        <DialogHeader className="flex-row items-center gap-3 border-b px-4 py-3 text-left">
          <History className="h-4 w-4 shrink-0 text-[var(--app-accent)]" />
          <DialogTitle className="min-w-0 truncate text-sm">{t("gitTimeline.title")}</DialogTitle>
          <select
            aria-label={t("gitTimeline.branch")}
            value={branch}
            disabled={!branchesReady || branches.length === 0}
            onChange={(event) => setBranch(event.target.value)}
            className="ml-auto h-8 min-w-0 max-w-56 rounded border bg-transparent px-2 text-xs"
          >
            {branches.length === 0 && <option value="">{t("gitTimeline.noLocalBranches")}</option>}
            {branches.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto md:grid-cols-[260px_280px_minmax(0,1fr)] md:overflow-hidden">
          <section className="min-h-40 overflow-auto border-b md:min-h-0 md:border-b-0 md:border-r" aria-label={t("gitTimeline.commits") }>
            {logError && <p className="px-3 py-2 text-xs text-[var(--app-status-danger)]">{logError}</p>}
            {logLoading && commits.length === 0 && (
              <div className="flex items-center gap-2 px-3 py-3 text-xs text-[var(--app-text-tertiary)]">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />{t("gitTimeline.loading")}
              </div>
            )}
            {!logLoading && !logError && commits.length === 0 && (
              <p className="px-3 py-3 text-xs text-[var(--app-text-tertiary)]">{t("gitTimeline.noCommits")}</p>
            )}
            {commits.map((commit) => (
              <button
                key={commit.hash}
                type="button"
                onClick={() => chooseCommit(commit)}
                className={`block w-full border-b px-3 py-2 text-left hover:bg-[var(--app-hover)] ${selectedCommit?.hash === commit.hash ? "bg-[var(--app-active-bg)]" : ""}`}
              >
                <span className="block truncate text-xs font-medium text-[var(--app-text-primary)]" title={commit.subject}>{commit.subject}</span>
                <span className="mt-1 flex min-w-0 gap-2 text-[10px] text-[var(--app-text-tertiary)]">
                  <code>{commit.shortHash}</code><span className="truncate">{commit.author}</span>
                </span>
                <span className="mt-0.5 block text-[10px] text-[var(--app-text-tertiary)]">{shortDate(commit.date)}</span>
              </button>
            ))}
            {hasMore && (
              <button type="button" onClick={loadMore} disabled={logLoading} className="w-full px-3 py-2 text-xs text-[var(--app-accent)] hover:bg-[var(--app-hover)] disabled:opacity-50">
                {t("gitTimeline.loadMore")}
              </button>
            )}
          </section>

          <section className="min-h-40 overflow-auto border-b md:min-h-0 md:border-b-0 md:border-r" aria-label={t("gitTimeline.files") }>
            <div className="flex h-10 items-center gap-2 border-b px-3">
              <GitCommitHorizontal className="h-3.5 w-3.5 text-[var(--app-text-tertiary)]" />
              <span className="truncate text-xs font-medium">{selectedCommit?.shortHash ?? t("gitTimeline.files")}</span>
              {selectedCommit && selectedCommit.parents.length > 1 && (
                <select
                  aria-label={t("gitTimeline.parent")}
                  value={parentIndex}
                  onChange={(event) => setParentIndex(Number(event.target.value))}
                  className="ml-auto h-7 min-w-0 max-w-32 rounded border bg-transparent px-1 text-[11px]"
                >
                  {selectedCommit.parents.map((parent, index) => (
                    <option key={parent} value={index}>{t("gitTimeline.parentOption", { index: index + 1 })}</option>
                  ))}
                </select>
              )}
            </div>
            {initialFile && !selectedCommit && (
              <button type="button" onClick={() => setDiffTarget({ kind: "worktree", file: initialFile })} className="flex w-full items-center gap-2 border-b px-3 py-2 text-left hover:bg-[var(--app-hover)]">
                <span className="w-4 text-xs font-semibold text-[var(--app-status-warning)]">{statusLetter(initialFile)}</span>
                <span className="min-w-0 truncate text-xs">{filePath(initialFile)}</span>
              </button>
            )}
            {!selectedCommit && !initialFile && <p className="px-3 py-3 text-xs text-[var(--app-text-tertiary)]">{t("gitTimeline.selectCommit")}</p>}
            {filesLoading && <p className="px-3 py-3 text-xs text-[var(--app-text-tertiary)]">{t("gitTimeline.loading")}</p>}
            {filesError && <p className="px-3 py-2 text-xs text-[var(--app-status-danger)]">{filesError}</p>}
            {!filesLoading && selectedCommit && !filesError && files.length === 0 && <p className="px-3 py-3 text-xs text-[var(--app-text-tertiary)]">{t("gitTimeline.noFiles")}</p>}
            {files.map((file) => (
              <button key={`${file.oldPath ?? ""}:${file.newPath ?? ""}`} type="button" onClick={() => chooseFile(file)} className="flex w-full items-center gap-2 border-b px-3 py-2 text-left hover:bg-[var(--app-hover)]">
                <span className="w-4 shrink-0 text-xs font-semibold text-[var(--app-status-warning)]">{statusLetter(file)}</span>
                <span className="min-w-0 truncate text-xs" title={filePath(file)}>{filePath(file)}</span>
              </button>
            ))}
          </section>

          <section className="min-h-64 min-w-0 overflow-hidden md:min-h-0" aria-label={t("gitTimeline.diff") }>
            <div className="flex h-10 items-center gap-2 border-b px-3">
              <FileDiff className="h-3.5 w-3.5 text-[var(--app-text-tertiary)]" />
              <span className="truncate text-xs font-medium">
                {diffTarget?.kind === "worktree"
                  ? `${t("gitTimeline.worktreeVsHead")} · ${t("gitTimeline.contentComparison")}`
                  : diffTarget
                    ? filePath(diffTarget.file)
                    : t("gitTimeline.diff")}
              </span>
            </div>
            <div className="h-[calc(100%-2.5rem)] min-h-0">
              {diffError
                ? <p className="px-3 py-3 text-xs text-[var(--app-status-danger)]">{diffError}</p>
                : <DiffView diff={diff} loading={diffLoading} />}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
