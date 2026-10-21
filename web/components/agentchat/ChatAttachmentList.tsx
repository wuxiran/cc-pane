import { useMemo, useRef, useState } from "react";
import { FileText, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogTitle, DialogClose } from "@/components/ui/dialog";
import type { AgentChatAttachment } from "@/types/agentChat";
import { chatAttachmentPreview } from "./chatAttachmentPreview";

function AttachmentCard({ attachment, onRemove }: { attachment: AgentChatAttachment; onRemove?: () => void }) {
  const { t } = useTranslation("panes");
  const source = useMemo(() => chatAttachmentPreview(attachment), [attachment]);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const previewButton = useRef<HTMLButtonElement | null>(null);
  const preview = source && source !== failedSource ? source : null;
  return (
    <div className={`group relative min-w-0 rounded-2xl border border-[var(--app-border)] bg-[var(--app-overlay)] ${preview ? "w-28 overflow-hidden" : "max-w-64"}`}>
      {preview ? (
        <button ref={previewButton} type="button" aria-label={t("agentChatPreviewAttachment", { name: attachment.name })}
          className="block w-full rounded-2xl text-left focus-visible:outline-2 focus-visible:outline-[var(--app-accent)]"
          onClick={() => setOpen(true)}>
          <img src={preview} alt={attachment.name} loading="lazy" decoding="async" onError={() => setFailedSource(source)}
            className="h-24 w-full bg-black/10 object-contain" />
          <span className="block truncate px-2 py-1.5 text-[11px] text-[var(--app-text-secondary)]" title={attachment.name}>{attachment.name}</span>
        </button>
      ) : (
        <span className={`flex items-center gap-2 px-3 py-2.5 text-xs text-[var(--app-text-secondary)] ${onRemove ? "pr-8" : ""}`}>
          <FileText className="h-4 w-4 shrink-0" /><span className="truncate" title={attachment.name}>{attachment.name}</span>
        </span>
      )}
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

export default function ChatAttachmentList({ attachments, onRemove, align = "start" }: {
  attachments: readonly AgentChatAttachment[];
  onRemove?: (index: number) => void;
  align?: "start" | "end";
}) {
  return <div className={`flex flex-wrap gap-2 ${align === "end" ? "justify-end" : ""}`}>
    {attachments.map((attachment, index) => <AttachmentCard key={`${index}:${attachment.path ?? attachment.name}`}
      attachment={attachment} onRemove={onRemove ? () => onRemove(index) : undefined} />)}
  </div>;
}
