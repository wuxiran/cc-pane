import { useMemo, useRef, useState } from "react";
import { FileText, Folder, ScanSearch, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogTitle, DialogClose } from "@/components/ui/dialog";
import type { AgentChatAttachment } from "@/types/agentChat";
import { chatAttachmentPreview } from "./chatAttachmentPreview";
import type { OpenChatAttachment } from "./useChatFileActions";

function AttachmentCard({ attachment, onRemove, onOpenAttachment }: {
  attachment: AgentChatAttachment; onRemove?: () => void; onOpenAttachment?: OpenChatAttachment;
}) {
  const { t } = useTranslation("panes");
  const source = useMemo(() => chatAttachmentPreview(attachment), [attachment]);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewButton = useRef<HTMLButtonElement | null>(null);
  const preview = source && source !== failedSource ? source : null;
  const openFile = async () => {
    if (opening) return;
    setError(null);
    if (!onOpenAttachment) { setOpen(true); return; }
    setOpening(true);
    try { if (!await onOpenAttachment(attachment)) setOpen(true); }
    catch (failure) { setError(String(failure)); }
    finally { setOpening(false); }
  };
  const label = onOpenAttachment ? t("agentChatOpenAttachment", { name: attachment.name }) : t("agentChatPreviewAttachment", { name: attachment.name });
  const Icon = attachment.isDirectory ? Folder : FileText;
  return (
    <div className={`group relative min-w-0 rounded-2xl border border-[var(--app-border)] bg-[var(--app-overlay)] ${preview ? "w-28 overflow-hidden" : "max-w-64"}`}>
      {preview ? (
        <button ref={previewButton} type="button" aria-label={label} aria-busy={opening} disabled={opening}
          className="block w-full rounded-2xl text-left focus-visible:outline-2 focus-visible:outline-[var(--app-accent)]"
          onClick={() => { void openFile(); }}>
          <img src={preview} alt={attachment.name} loading="lazy" decoding="async" onError={() => setFailedSource(source)}
            className="h-24 w-full bg-black/10 object-contain" />
          <span className="block truncate px-2 py-1.5 text-[11px] text-[var(--app-text-secondary)]" title={attachment.name}>{attachment.name}</span>
        </button>
      ) : (
        onOpenAttachment ? <button type="button" aria-label={label} aria-busy={opening} disabled={opening}
          className={`flex max-w-full items-center gap-2 rounded-2xl px-3 py-2.5 text-xs text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] focus-visible:outline-2 focus-visible:outline-[var(--app-accent)] ${onRemove ? "pr-8" : ""}`}
          onClick={() => { void openFile(); }}>
          <Icon className="h-4 w-4 shrink-0" /><span className="truncate" title={attachment.path || attachment.name}>{attachment.name}</span>
        </button> : <span className={`flex items-center gap-2 px-3 py-2.5 text-xs text-[var(--app-text-secondary)] ${onRemove ? "pr-8" : ""}`}>
          <Icon className="h-4 w-4 shrink-0" /><span className="truncate" title={attachment.name}>{attachment.name}</span>
        </span>
      )}
      {preview && onOpenAttachment ? <button type="button" aria-label={t("agentChatQuickPreview", { name: attachment.name })}
        title={t("agentChatQuickPreview", { name: attachment.name })}
        className="absolute left-1 top-1 rounded-full border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-1 text-[var(--app-text-secondary)] shadow-sm hover:text-[var(--app-text-primary)]"
        onClick={(event) => { previewButton.current = event.currentTarget; setOpen(true); }}><ScanSearch className="h-3 w-3" /></button> : null}
      {error ? <span role="alert" className="block px-2 pb-2 text-xs text-[var(--app-status-danger)]">{error}</span> : null}
      {onRemove ? (
        <button type="button" aria-label={t("agentChatRemoveAttachment")} title={t("agentChatRemoveAttachment")}
          className="absolute right-1 top-1 rounded-full border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-1 text-[var(--app-text-secondary)] shadow-sm hover:text-[var(--app-status-danger)] focus-visible:outline-2 focus-visible:outline-[var(--app-accent)]"
          onClick={onRemove}><X className="h-3 w-3" /></button>
      ) : null}
      <Dialog open={open && Boolean(preview)} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-[min(90vw,72rem)]" showCloseButton={false} aria-describedby={undefined}
          onCloseAutoFocus={(event) => { event.preventDefault(); previewButton.current?.focus(); }}>
          <DialogTitle className="pr-8 break-all text-sm">{attachment.name}</DialogTitle>
          <DialogClose aria-label={t("agentChatClosePreview")} className="absolute right-4 top-4 rounded p-1 hover:bg-[var(--app-hover)]"><X className="h-4 w-4" /></DialogClose>
          {preview ? <img src={preview} alt={attachment.name} className="mx-auto max-h-[75vh] max-w-full object-contain" onError={() => setFailedSource(source)} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function ChatAttachmentList({ attachments, onRemove, onOpenAttachment, align = "start" }: {
  attachments: readonly AgentChatAttachment[];
  onRemove?: (index: number) => void;
  onOpenAttachment?: OpenChatAttachment;
  align?: "start" | "end";
}) {
  return <div className={`flex flex-wrap gap-2 ${align === "end" ? "justify-end" : ""}`}>
    {attachments.map((attachment, index) => <AttachmentCard key={`${index}:${attachment.path ?? attachment.name}`}
      attachment={attachment} onOpenAttachment={onOpenAttachment} onRemove={onRemove ? () => onRemove(index) : undefined} />)}
  </div>;
}
