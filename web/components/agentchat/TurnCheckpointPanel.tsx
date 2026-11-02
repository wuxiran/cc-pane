import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { TurnCheckpointFile } from "@/types/turnCheckpoint";
import { useTurnCheckpoints } from "./useTurnCheckpoints";

interface Props {
  chatId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  generating: boolean;
  initialCheckpointId?: string;
}

export default function TurnCheckpointPanel({ chatId, open, onOpenChange, generating, initialCheckpointId }: Props) {
  const { t } = useTranslation(["panes", "agentRuntime"]);
  const state = useTurnCheckpoints(chatId, open, generating, initialCheckpointId);
  const [confirmed, setConfirmed] = useState(false);
  const [path, setPath] = useState("");
  useEffect(() => { setConfirmed(false); setPath(""); }, [state.review, chatId, generating]);
  const selected = state.review?.files.find((file) => file.path === path) ?? state.review?.files[0];
  const canRestore = state.review?.canRestore && !generating && !state.loading && !state.restoring;
  return <Dialog open={open} onOpenChange={(value) => { if (!state.restoring) onOpenChange(value); }}>
    <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-5xl">
      <DialogHeader>
        <DialogTitle>{t("turnCheckpointTitle", { defaultValue: "Turn checkpoints" })}</DialogTitle>
        <DialogDescription>{t("turnCheckpointScope", { defaultValue: "Review working-tree changes captured before and after each turn, including changes made by tools or other processes. Restore changes files only; it does not undo commits, the Git index, commands or external actions." })}</DialogDescription>
      </DialogHeader>
      <p className="text-xs text-[var(--app-text-tertiary)]">{t("turnCheckpointLimits", { defaultValue: "Scope: tracked files and nonignored untracked files. New ignored files and paths outside the repository are excluded. Limits: 20,000 files, 32 MiB per file, 256 MiB total. Exceeding a limit disables the checkpoint. Recent 200 turns are listed." })}</p>
      <div className="flex items-center gap-2">
        <select className="min-w-0 flex-1 rounded border bg-[var(--app-bg-secondary)] p-2 text-sm" aria-label={t("turnCheckpointSelect", { defaultValue: "Select turn checkpoint" })}
          value={state.selectedId} disabled={state.restoring} onChange={(event) => { state.select(event.target.value); setConfirmed(false); }}>
          {state.selectedId && !state.records.some((record) => record.id === state.selectedId) && <option value={state.selectedId}>{state.selectedId}</option>}
          {!state.records.length && !state.selectedId && <option value="">{t("turnCheckpointEmpty", { defaultValue: "No checkpoints yet" })}</option>}
          {state.records.map((record) => <option key={record.id} value={record.id}>{new Date(record.createdAt).toLocaleString()} · {t(`agentRuntime:status.${record.outcome}`, { defaultValue: record.outcome })} · {record.turnId.slice(0, 8)}</option>)}
        </select>
        <Button variant="outline" disabled={state.loading || state.restoring} onClick={state.reload}>{t("turnCheckpointReload", { defaultValue: "Refresh review" })}</Button>
      </div>
      {state.loading && <p role="status">{t("turnCheckpointLoading", { defaultValue: "Reading checkpoint and current files…" })}</p>}
      {state.error && <p role="alert" className="text-sm text-[var(--app-status-danger)]">{state.error}</p>}
      {state.result && <p role="status" className="text-sm">{t("turnCheckpointRestored", { defaultValue: "Restored {{count}} files. The pre-restore snapshot was retained for recovery.", count: state.result.restoredPaths.length })} {state.result.warning}</p>}
      {state.review && <>
        <p className="truncate text-xs text-[var(--app-text-tertiary)]" title={state.review.record.cwd}>{state.review.record.cwd}</p>
        {state.review.blockedReason && <p role="status" className="text-sm text-[var(--app-status-warning)]">{state.review.blockedReason}</p>}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden sm:flex-row">
          <div className="max-h-40 shrink-0 overflow-auto rounded border sm:max-h-80 sm:w-64" aria-label={t("turnCheckpointFiles", { defaultValue: "Changed files" })}>
            {state.review.files.map((file) => <button key={file.path} type="button" className={`block w-full break-all px-3 py-2 text-left text-xs hover:bg-[var(--app-hover)] ${selected?.path === file.path ? "bg-[var(--app-hover)]" : ""}`} onClick={() => setPath(file.path)}>
              <span>{file.path}</span><span className="ml-2 text-[var(--app-text-tertiary)]">{t(`turnCheckpointFileStatus.${file.status}`, { defaultValue: file.status })}{file.conflict ? " ⚠" : ""}</span>
            </button>)}
          </div>
          {selected && <CheckpointFilePreview file={selected} />}
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={confirmed} disabled={!canRestore} onChange={(event) => setConfirmed(event.target.checked)} />
          {t("turnCheckpointConfirm", { defaultValue: "I reviewed this turn's changed files. Restore all of them to their pre-turn contents; keep unrelated files and block if any changed file has later edits." })}
        </label>
        <Button variant="destructive" disabled={!canRestore || !confirmed} onClick={() => { setConfirmed(false); void state.restore(); }}>
          {t("turnCheckpointRestore", { defaultValue: "Restore whole turn ({{count}} files)", count: state.review.files.length })}
        </Button>
      </>}
    </DialogContent>
  </Dialog>;
}

function CheckpointFilePreview({ file }: { file: TurnCheckpointFile }) {
  const { t } = useTranslation("panes");
  if (file.previewOmitted) return <p className="text-sm">{t("turnCheckpointPreviewOmitted", { defaultValue: "Binary or large-file text preview omitted. The captured bytes are retained; restore still checks the complete file." })}</p>;
  return <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 overflow-auto sm:grid-cols-2">
    {([
      [t("turnCheckpointBefore", { defaultValue: "Before turn · restore target" }), file.beforeContent],
      [t("turnCheckpointAfter", { defaultValue: "After turn" }), file.afterContent],
    ] as const).map(([label, text]) => <div key={label} className="min-w-0">
      <p className="mb-1 text-xs font-medium">{label}</p>
      <pre className="max-h-72 overflow-auto rounded border bg-[var(--app-bg-secondary)] p-2 text-xs">{text ?? t("turnCheckpointAbsent", { defaultValue: "File absent" })}</pre>
    </div>)}
  </div>;
}
