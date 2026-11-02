// Three-pane conflict resolution dialog (F3.2).
//
// Layout: conflict file list on the left, ours / result / theirs panes on the
// right. Saving writes the result pane back to disk and `git add`s the file via
// the backend. Binary or oversized conflicts degrade to an honest notice
// instead of pretending text resolution is possible.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, GitMerge, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  gitService,
  type GitConflictFile,
  type GitConflictSummary,
  type GitConflictVersions,
  type GitMergeState,
} from "@/services/gitService";
import {
  acceptSide,
  initialResultText,
  sortConflictFiles,
  toVersionViews,
  type ConflictVersionViews,
  type SideView,
} from "./conflictModel";

const MERGE_STATE_KEYS = {
  clean: "gitConflict.stateClean",
  merging: "gitConflict.stateMerging",
  rebasing: "gitConflict.stateRebasing",
  cherryPicking: "gitConflict.stateCherryPicking",
} as const satisfies Record<GitMergeState, string>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SidePaneProps {
  label: string;
  side: SideView;
  editable?: boolean;
  value?: string;
  onChange?: (next: string) => void;
  onAccept?: () => void;
  acceptLabel?: string;
}

/** One of ours / result / theirs panes with honest degradation messaging. */
function SidePane({ label, side, editable, value, onChange, onAccept, acceptLabel }: SidePaneProps) {
  const { t } = useTranslation("dialogs");
  const notice = (() => {
    if (side.unavailableReason === "binary") return t("gitConflict.binaryUnsupported");
    if (side.unavailableReason === "tooLarge") return t("gitConflict.tooLarge");
    if (side.unavailableReason === "missing") return t("gitConflict.missingSide");
    return null;
  })();

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={label}>
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b px-2">
        <span className="min-w-0 truncate text-xs font-medium text-[var(--app-text-secondary)]">{label}</span>
        {onAccept && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onAccept}
            disabled={side.unavailableReason !== null}
            className="ml-auto shrink-0"
          >
            {acceptLabel}
          </Button>
        )}
      </div>
      {notice ? (
        <p className="flex min-h-0 flex-1 items-start gap-1.5 px-2 py-2 text-[length:var(--text-caption)] leading-snug text-[var(--app-status-warning)]">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          {notice}
        </p>
      ) : editable ? (
        <textarea
          value={value ?? ""}
          onChange={(event) => onChange?.(event.target.value)}
          spellCheck={false}
          data-testid="conflict-result-editor"
          className="min-h-0 w-full flex-1 resize-none bg-transparent px-2 py-1.5 font-mono text-xs leading-relaxed text-[var(--app-text-primary)] outline-none"
        />
      ) : (
        <pre
          data-testid={`conflict-${side.side}-view`}
          className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all px-2 py-1.5 font-mono text-xs leading-relaxed text-[var(--app-text-secondary)]"
        >
          {side.content}
        </pre>
      )}
    </section>
  );
}

export interface ConflictResolveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string;
  /** Repo-relative path to preselect; null opens the first conflicted file. */
  initialFile: string | null;
  /** Called after a successful resolve so callers can refresh their git state. */
  onResolved?: (path: string, remaining: number) => void;
}

export default function ConflictResolveDialog({
  open,
  onOpenChange,
  projectPath,
  initialFile,
  onResolved,
}: ConflictResolveDialogProps) {
  const { t } = useTranslation("dialogs");
  const { t: tCommon } = useTranslation("common");
  const [summary, setSummary] = useState<GitConflictSummary | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [versions, setVersions] = useState<GitConflictVersions | null>(null);
  const [result, setResult] = useState("");
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const summaryRequestId = useRef(0);
  const versionsRequestId = useRef(0);

  const files = useMemo<GitConflictFile[]>(
    () => (summary ? sortConflictFiles(summary.files) : []),
    [summary],
  );

  const loadSummary = useCallback(() => {
    if (!projectPath) return;
    const requestId = ++summaryRequestId.current;
    setLoadingSummary(true);
    setError(null);
    setSummary(null);
    gitService
      .listConflicts(projectPath)
      .then((next) => {
        if (summaryRequestId.current !== requestId) return;
        setSummary(next);
        setLoadingSummary(false);
        setActivePath((current) => {
          const paths = sortConflictFiles(next.files).map((file) => file.path);
          if (current && paths.includes(current)) return current;
          if (initialFile && paths.includes(initialFile)) return initialFile;
          return paths[0] ?? null;
        });
      })
      .catch((cause) => {
        if (summaryRequestId.current !== requestId) return;
        setError(t("gitConflict.loadError", { message: messageOf(cause) }));
        setLoadingSummary(false);
      });
  }, [initialFile, projectPath, t]);

  useEffect(() => {
    if (!open || !projectPath) return;
    setResult("");
    setVersions(null);
    setNotice(null);
    loadSummary();
    return () => {
      summaryRequestId.current += 1;
      versionsRequestId.current += 1;
    };
  }, [loadSummary, open, projectPath]);

  useEffect(() => {
    if (!open || !projectPath || !activePath) {
      setVersions(null);
      return;
    }
    const requestId = ++versionsRequestId.current;
    setLoadingVersions(true);
    setError(null);
    gitService
      .getConflictVersions(projectPath, activePath)
      .then((next) => {
        if (versionsRequestId.current !== requestId) return;
        setVersions(next);
        setResult(initialResultText(next));
        setLoadingVersions(false);
      })
      .catch((cause) => {
        if (versionsRequestId.current !== requestId) return;
        setError(t("gitConflict.loadError", { message: messageOf(cause) }));
        setLoadingVersions(false);
      });
  }, [activePath, open, projectPath, t]);

  const views: ConflictVersionViews | null = versions ? toVersionViews(versions) : null;

  const handleSave = useCallback(() => {
    if (!projectPath || !activePath) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    gitService
      .resolveConflict({ path: projectPath, file: activePath, content: result })
      .then((outcome) => {
        setSaving(false);
        setNotice(
          t("gitConflict.stagedRemaining", { path: outcome.path, count: outcome.remainingConflicts }),
        );
        onResolved?.(outcome.path, outcome.remainingConflicts);
        if (outcome.remainingConflicts === 0) {
          setActivePath(null);
          setSummary((current) =>
            current ? { ...current, hasConflicts: false, files: [], mergeState: "clean" } : current,
          );
        } else {
          loadSummary();
        }
      })
      .catch((cause) => {
        setSaving(false);
        setError(t("gitConflict.saveError", { message: messageOf(cause) }));
      });
  }, [activePath, loadSummary, onResolved, projectPath, result, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(88vh,880px)] w-[calc(100vw-1.5rem)] max-w-none gap-0 overflow-hidden p-0 sm:max-w-[1280px]">
        <DialogHeader className="flex-row items-center gap-3 border-b px-4 py-3 text-left">
          <GitMerge className="h-4 w-4 shrink-0 text-[var(--app-status-danger)]" />
          <DialogTitle className="min-w-0 truncate text-sm">{t("gitConflict.title")}</DialogTitle>
          {summary && (
            <span className="ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[length:var(--text-caption)] text-[var(--app-text-secondary)]">
              {t(MERGE_STATE_KEYS[summary.mergeState])}
              {summary.theirsRef ? ` · ${t("gitConflict.theirsRef", { ref: summary.theirsRef })}` : ""}
            </span>
          )}
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[240px_minmax(0,1fr)]">
          <section
            className="min-h-0 overflow-auto border-b md:border-b-0 md:border-r"
            aria-label={t("gitConflict.file")}
          >
            {loadingSummary && (
              <div className="flex items-center gap-2 px-3 py-3 text-xs text-[var(--app-text-tertiary)]">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                {t("gitConflict.title")}
              </div>
            )}
            {!loadingSummary && files.length === 0 && !error && (
              <p className="px-3 py-3 text-xs text-[var(--app-text-tertiary)]">{t("gitConflict.noFiles")}</p>
            )}
            {files.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => setActivePath(file.path)}
                data-testid={`conflict-file-${file.path}`}
                aria-current={activePath === file.path ? "true" : undefined}
                className={`flex w-full items-center gap-2 border-b px-3 py-2 text-left text-xs hover:bg-[var(--app-hover)] ${
                  activePath === file.path ? "bg-[var(--app-active-bg)]" : ""
                }`}
              >
                <span className="w-3 shrink-0 text-center font-semibold text-[var(--app-status-danger)]">!</span>
                <span className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</span>
                {file.isBinary && <AlertTriangle className="h-3 w-3 shrink-0 text-[var(--app-status-warning)]" />}
              </button>
            ))}
          </section>

          <div className="flex min-h-0 min-w-0 flex-col">
            {error && (
              <p className="border-b px-3 py-2 text-xs text-[var(--app-status-danger)]">{error}</p>
            )}
            {notice && (
              <p className="border-b px-3 py-2 text-xs text-[var(--app-status-success)]">{notice}</p>
            )}
            {loadingVersions || (!versions && !error && activePath) ? (
              <div className="flex flex-1 items-center justify-center gap-2 text-xs text-[var(--app-text-tertiary)]">
                <LoaderCircle className="h-4 w-4 animate-spin" />
              </div>
            ) : views && versions ? (
              <>
                <div className="grid min-h-0 flex-1 grid-cols-1 gap-px overflow-hidden md:grid-cols-3">
                  <SidePane
                    label={t("gitConflict.ours")}
                    side={views.ours}
                    onAccept={
                      views.resolvable
                        ? () => setResult(acceptSide(views, "ours") ?? result)
                        : undefined
                    }
                    acceptLabel={t("gitConflict.useOurs")}
                  />
                  <SidePane
                    label={t("gitConflict.result")}
                    side={views.result}
                    editable={views.resolvable}
                    value={result}
                    onChange={setResult}
                  />
                  <SidePane
                    label={t("gitConflict.theirs")}
                    side={views.theirs}
                    onAccept={
                      views.resolvable
                        ? () => setResult(acceptSide(views, "theirs") ?? result)
                        : undefined
                    }
                    acceptLabel={t("gitConflict.useTheirs")}
                  />
                </div>
                <DialogFooter className="shrink-0 border-t px-3 py-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => onOpenChange(false)}
                  >
                    {tCommon("cancel")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleSave}
                    disabled={saving || !views.resolvable}
                    data-testid="conflict-save"
                  >
                    {saving ? t("gitConflict.saving") : t("gitConflict.save")}
                  </Button>
                </DialogFooter>
              </>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
