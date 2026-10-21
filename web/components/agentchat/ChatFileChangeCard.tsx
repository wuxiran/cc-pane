import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FilePlus2, FilePenLine, Loader2, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { undoAgentFileEdit } from "@/services/agentEditService";
import { translateError } from "@/utils/errorTranslation";
import type { FileEditBlock } from "./fileEdits";

interface Props {
  block: FileEditBlock;
  toolCallId: string;
  chatId?: string;
  undoable: boolean;
  renderDiff: () => ReactNode;
  onOpenFile?: (path: string) => void;
}

export default function ChatFileChangeCard({ block, toolCallId, chatId, undoable, renderDiff, onOpenFile }: Props) {
  const { t } = useTranslation("panes");
  const snapshot = useAgentChatStore((state) => chatId ? state.chats[chatId]?.snapshot : undefined);
  const [expanded, setExpanded] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [undone, setUndone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const identity = useMemo(() => ({}), [chatId, snapshot?.acpSessionId, toolCallId, block.path, block.oldText, block.newText]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  useEffect(() => { setUndone(false); setUndoing(false); setError(null); }, [identity]);
  const name = block.path.split(/[\\/]/).pop() || block.path;
  const created = block.oldText === null;
  const Icon = created ? FilePlus2 : FilePenLine;
  const ready = snapshot?.phase === "ready" && Boolean(snapshot.acpSessionId);
  const undoDisabled = !undoable || !chatId || !ready || undoing || undone;

  async function undo() {
    if (undoDisabled || !chatId || !snapshot?.acpSessionId) return;
    setUndoing(true);
    setError(null);
    try {
      await undoAgentFileEdit(chatId, { acpSessionId: snapshot.acpSessionId, toolCallId, path: block.path, oldText: block.oldText, newText: block.newText });
      if (currentIdentity.current === identity) setUndone(true);
    } catch (cause) {
      const detail = translateError(cause);
      if (currentIdentity.current === identity) setError(detail || t("agentChatUndoEditFailed", { defaultValue: "Undo failed; the current file was preserved" }));
    } finally {
      if (currentIdentity.current === identity) setUndoing(false);
    }
  }

  return (
    <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-hover)]" data-testid="chat-file-change">
      <div className="flex flex-wrap items-center gap-3 p-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--app-bg-deep)]">
          <Icon className="h-5 w-5 text-[var(--app-icon-inactive)]" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={block.path}>
            {created ? t("agentChatFileCreated", { name, defaultValue: "Created {{name}}" }) : t("agentChatFileEdited", { name, defaultValue: "Edited {{name}}" })}
          </div>
          {onOpenFile ? <button type="button" className="mt-0.5 max-w-full truncate text-xs text-[var(--app-text-secondary)] hover:underline" onClick={() => onOpenFile(block.path)} title={block.path}>{block.path}</button> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" disabled={undoDisabled} onClick={() => void undo()}
            title={!undoable ? t("agentChatUndoEditUnavailable", { defaultValue: "The complete original content is unavailable for safe undo" }) : !ready ? t("agentChatUndoEditBusy", { defaultValue: "Wait for this conversation to finish before undoing" }) : undefined}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors hover:bg-[var(--app-active-bg)] disabled:cursor-default disabled:opacity-45">
            {undoing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />}
            {undone ? t("agentChatEditUndone", { defaultValue: "Undone" }) : undoing ? t("agentChatUndoingEdit", { defaultValue: "Undoing…" }) : t("agentChatUndoEdit", { defaultValue: "Undo" })}
          </button>
          <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} className="rounded-lg border border-[var(--app-border)] px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--app-active-bg)]">
            {t("agentChatViewChanges", { defaultValue: "View changes" })}
          </button>
        </div>
      </div>
      {error ? <div role="alert" className="px-3 pb-3 text-xs text-[var(--app-status-danger)]">{error}</div> : null}
      {expanded ? <div className="border-t border-[var(--app-border)] p-2">{renderDiff()}</div> : null}
    </div>
  );
}
