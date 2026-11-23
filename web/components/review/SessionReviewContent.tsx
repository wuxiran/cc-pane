import "@/i18n/sessionReviewResources";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronsDownUp, ChevronsUpDown, RefreshCw, WrapText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { usePanesStore } from "@/stores/usePanesStore";
import { turnCheckpointService } from "@/services/turnCheckpointService";
import { isTauriRuntime } from "@/services/runtime";
import { getErrorMessage } from "@/utils";
import { reviewFilePath, type ReviewFile, type ReviewScope } from "./reviewData";
import ReviewRepoHeader, { fileKey } from "./ReviewRepoHeader";
import { useSessionReview } from "./useSessionReview";
import ReviewFileCard from "./ReviewFileCard";

export interface SessionReviewContentProps {
  projectPath: string;
  checkpointChatId?: string;
  cliSessionId?: string;
  open: boolean;
  paneId?: string;
  onOpenFile?: () => void;
}

export default function SessionReviewContent({ projectPath, checkpointChatId, cliSessionId, open, paneId, onOpenFile }: SessionReviewContentProps) {
  const { t } = useTranslation("review");
  const inputId = useId();
  const state = useSessionReview(projectPath, checkpointChatId, open, t("noRepo"));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [wrap, setWrap] = useState(true);
  const [baseDraft, setBaseDraft] = useState("");
  const [recording, setRecording] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const identity = useRef(0);
  useEffect(() => {
    identity.current++; setActionError(null); setRecording(false); setBaseDraft("");
    return () => { identity.current++; };
  }, [projectPath, cliSessionId, open]);
  useEffect(() => { setCollapsed(new Set()); }, [state.scope, state.checkpointId, projectPath]);
  useEffect(() => { setBaseDraft(state.baseRef); }, [state.baseRef]);
  const running = state.records.find((record) => record.outcome === "running" && !record.completedAt);
  const completed = state.records.filter((record) => record.completedAt);
  const stats = useMemo(() => state.files.reduce((total, file) => ({
    additions: total.additions + (file.diff?.stats.additions ?? 0), deletions: total.deletions + (file.diff?.stats.deletions ?? 0),
    partial: total.partial || Boolean(file.error || file.previewOmitted || file.diff?.truncated || file.diff?.isBinary),
  }), { additions: 0, deletions: 0, partial: false }), [state.files]);

  const record = async () => {
    if (!cliSessionId || recording) return;
    const epoch = identity.current;
    setRecording(true); setActionError(null);
    try {
      const result = running ? await turnCheckpointService.finishCli(cliSessionId, running.id) : await turnCheckpointService.beginCli(cliSessionId);
      if (epoch !== identity.current) return;
      if (result.unavailableReason) setActionError(result.unavailableReason);
      if (result.completedAt) state.selectCheckpoint(result.id);
      state.reload();
    } catch (cause) { if (epoch === identity.current) setActionError(getErrorMessage(cause)); }
    finally { if (epoch === identity.current) setRecording(false); }
  };
  const branchError = state.scope === "branch" ? state.branchError : null;
  const openFile = (file: ReviewFile) => {
    const root = file.repoRoot ?? state.root;
    const relative = file.path;
    const path = reviewFilePath(root, relative);
    if (!path) { setActionError(t("invalidPath")); return; }
    usePanesStore.getState().openEditor(root, path, relative.split(/[\\/]/).pop() ?? relative, undefined, { forcePaneTab: true, paneId });
    onOpenFile?.();
  };

  return <section className="flex h-full min-h-0 flex-col gap-3 overflow-hidden bg-[var(--app-content)] p-4" aria-label={t("title")}>
      <header className="shrink-0"><h2 className="text-sm font-medium">{t("title")}</h2><p className="truncate text-xs text-[var(--app-text-tertiary)]" title={state.root}>{state.root}{state.repos.length > 1 ? ` · ${t("repoCount", { count: state.repos.length })}` : ""}</p></header>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--app-border)] pb-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-full bg-[var(--app-sidebar)] px-4 py-1.5">
        <select aria-label={t("scope")} value={state.scope} onChange={(event) => state.setScope(event.target.value as ReviewScope)} className="cursor-default rounded-md border-0 bg-transparent py-1 pr-1 text-sm font-medium outline-none">
          <option value="turn" disabled={!checkpointChatId || !isTauriRuntime()}>{t("turn")}</option>
          <option value="workspace">{t("workspace")}</option><option value="branch">{t("branch")}</option>
        </select>
        {state.repos.length > 1 && <select aria-label={t("repo")} value={state.repoFilter} onChange={(event) => state.setRepoFilter(event.target.value)} className="max-w-48 cursor-default truncate rounded-md border-0 bg-transparent py-1 pr-6 text-sm text-[var(--app-text-primary)] outline-none">
          {state.scope !== "branch" && <option value="">{t("allRepos", { count: state.repos.length })}</option>}
          {state.repos.map((repo) => <option key={repo.root} value={repo.root}>{repo.label}{repo.branch ? ` · ${repo.branch}` : ""}</option>)}
        </select>}
        <div className="flex gap-2 font-mono text-sm tabular-nums" aria-label={t("totalStats")}>
          <span className="text-[var(--app-status-success)]">+{stats.additions}</span><span className="text-[var(--app-status-danger)]">-{stats.deletions}</span>
          <span className="text-[var(--app-text-tertiary)]">{t("files", { count: state.files.length })}</span>
        </div>
        </div>
        {(state.loading || stats.partial) && <span className="text-xs text-[var(--app-text-tertiary)]">{t(state.loading ? "counting" : "partialStats")}</span>}
        <span className="flex-1" />
        <div className="flex items-center gap-0.5 rounded-full bg-[var(--app-sidebar)] p-1 [&_button]:size-8 [&_button]:rounded-full">
        <Button variant="ghost" size="icon" aria-label={t("refresh")} onClick={state.reload}><RefreshCw className={`size-4 ${state.loading ? "animate-spin" : ""}`} /></Button>
        <Button variant="ghost" size="icon" aria-label={t("expandAll")} onClick={() => setCollapsed(new Set())}><ChevronsUpDown className="size-4" /></Button>
        <Button variant="ghost" size="icon" aria-label={t("collapseAll")} onClick={() => setCollapsed(new Set(state.files.map(fileKey)))}><ChevronsDownUp className="size-4" /></Button>
        <Button variant={wrap ? "secondary" : "ghost"} size="icon" aria-label={t("wrap")} aria-pressed={wrap} onClick={() => setWrap((value) => !value)}><WrapText className="size-4" /></Button>
        </div>
      </div>
      {state.scope === "branch" && <form className="flex shrink-0 flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); state.setBaseRef(baseDraft.trim()); state.reload(); }}>
        <label htmlFor={inputId} className="text-sm">{t("baseRef")}</label><input id={inputId} list={`${inputId}-branches`} value={baseDraft} onChange={(event) => setBaseDraft(event.target.value)} placeholder={t("basePlaceholder")} className="min-w-0 flex-1 rounded border bg-[var(--app-sidebar)] p-2 text-sm" />
        <datalist id={`${inputId}-branches`}>{state.branches.map((branch) => <option key={branch} value={branch} />)}</datalist>
        <Button type="submit" variant="outline" disabled={!baseDraft.trim()}>{t("compare")}</Button>{state.branchesLoading && <span className="text-xs">{t("loadingBranches")}</span>}{state.range && <code className="text-xs text-[var(--app-text-tertiary)]">{state.range}</code>}
      </form>}
      {state.scope === "turn" && <div className="shrink-0 space-y-2">
        {completed.length > 0 && <select aria-label={t("selectTurn")} value={state.checkpointId} onChange={(event) => state.selectCheckpoint(event.target.value)} className="w-full rounded border bg-[var(--app-sidebar)] p-2 text-sm">
          {completed.map((item, index) => <option key={item.id} value={item.id}>{index === 0 ? `${t("latest")} · ` : ""}{new Date(item.createdAt).toLocaleString()} · {t(`outcome.${item.outcome}`, { defaultValue: item.outcome })}</option>)}
        </select>}
        {cliSessionId && <div className="flex flex-wrap items-center gap-2"><Button variant="outline" disabled={recording || state.recordsLoading || Boolean(state.checkpointError)} onClick={() => void record()}>{recording ? t("recordingBusy") : running ? t("finishRecording") : t("beginRecording")}</Button><span className="text-xs text-[var(--app-text-tertiary)]">{t(running ? "recordingActive" : "manualHint")}</span></div>}
        {state.recordsLoading && <p role="status" className="text-sm">{t("loadingTurns")}</p>}
        {state.checkpointError && <p role="alert" className="text-sm text-[var(--app-status-danger)]">{state.checkpointError}</p>}
      </div>}
      <p className="shrink-0 text-xs text-[var(--app-text-tertiary)]">{t(state.scope === "turn" ? "turnScope" : state.scope === "branch" ? "branchScope" : "workspaceScope")}</p>
      {(state.notice || actionError || state.error || branchError) && <div role="alert" className="shrink-0 space-y-1 text-sm text-[var(--app-status-warning)]">{[state.notice, actionError, state.error, branchError].filter(Boolean).map((message, index) => <p key={index}>{message}</p>)}</div>}
      <div className="min-h-0 flex-1 space-y-3 overflow-auto" aria-label={t("changedFiles")}>
        {!state.files.length && !state.loading && !state.error && !state.notice && !branchError && !(state.scope === "turn" && state.checkpointError) && <p className="px-3 py-10 text-center text-sm text-[var(--app-text-tertiary)]">{t(state.scope === "turn" && !state.checkpointId ? "noTurn" : state.scope === "branch" && !state.baseRef ? "chooseBase" : "noChanges")}</p>}
        {state.files.map((file, index) => <div key={fileKey(file)} className="space-y-3">
          {state.multiRepo && file.repoRoot !== state.files[index - 1]?.repoRoot && <ReviewRepoHeader repos={state.repos} files={state.files} repoRoot={file.repoRoot} />}
          <ReviewFileCard file={file} expanded={!collapsed.has(fileKey(file))} wrap={wrap} onOpen={() => openFile(file)} onToggle={() => setCollapsed((previous) => { const next = new Set(previous); const key = fileKey(file); if (next.has(key)) next.delete(key); else next.add(key); return next; })} />
        </div>)}
      </div>
  </section>;
}
