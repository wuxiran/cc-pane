import "@/i18n/sessionReviewResources";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronsDownUp, ChevronsUpDown, RefreshCw, WrapText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { usePanesStore } from "@/stores/usePanesStore";
import { turnCheckpointService } from "@/services/turnCheckpointService";
import { isTauriRuntime } from "@/services/runtime";
import { getErrorMessage } from "@/utils";
import { reviewFilePath, type ReviewScope } from "./reviewData";
import { useSessionReview } from "./useSessionReview";
import ReviewFileCard from "./ReviewFileCard";

interface Props {
  projectPath: string;
  checkpointChatId?: string;
  cliSessionId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SessionReviewPanel({ projectPath, checkpointChatId, cliSessionId, open, onOpenChange }: Props) {
  const { t } = useTranslation("review");
  const inputId = useId();
  const state = useSessionReview(projectPath, checkpointChatId, open);
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
  const openFile = (relative: string) => {
    const path = reviewFilePath(state.root, relative);
    if (!path) { setActionError(t("invalidPath")); return; }
    usePanesStore.getState().openEditor(state.root, path, relative.split(/[\\/]/).pop() ?? relative);
    onOpenChange(false);
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex h-[min(90vh,1000px)] w-[96vw] flex-col gap-3 overflow-hidden rounded-2xl border-[var(--app-border)] bg-[var(--app-content)] p-4 shadow-2xl sm:max-w-[1440px]">
      <DialogHeader className="shrink-0 pr-8"><DialogTitle className="text-sm font-medium">{t("title")}</DialogTitle><DialogDescription className="truncate" title={state.root}>{state.root}</DialogDescription></DialogHeader>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--app-border)] pb-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-full bg-[var(--app-sidebar)] px-4 py-1.5">
        <select aria-label={t("scope")} value={state.scope} onChange={(event) => state.setScope(event.target.value as ReviewScope)} className="cursor-pointer rounded-md border-0 bg-transparent py-1 pr-1 text-sm font-medium outline-none">
          <option value="turn" disabled={!checkpointChatId || !isTauriRuntime()}>{t("turn")}</option>
          <option value="workspace">{t("workspace")}</option><option value="branch">{t("branch")}</option>
        </select>
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
        <Button variant="ghost" size="icon" aria-label={t("collapseAll")} onClick={() => setCollapsed(new Set(state.files.map((file) => file.path)))}><ChevronsDownUp className="size-4" /></Button>
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
        {state.files.map((file) => <ReviewFileCard key={file.path} file={file} expanded={!collapsed.has(file.path)} wrap={wrap} onOpen={() => openFile(file.path)} onToggle={() => setCollapsed((previous) => { const next = new Set(previous); if (next.has(file.path)) next.delete(file.path); else next.add(file.path); return next; })} />)}
      </div>
    </DialogContent>
  </Dialog>;
}
