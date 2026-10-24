import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import DiffView from "@/components/DiffView";
import type { ReviewFile } from "./reviewData";

export default function ReviewFileCard({ file, expanded, wrap, onToggle, onOpen }: {
  file: ReviewFile; expanded: boolean; wrap: boolean; onToggle: () => void; onOpen: () => void;
}) {
  const { t } = useTranslation("review");
  const pending = !file.diff && !file.error && !file.previewOmitted;
  return <article className="overflow-hidden rounded-lg border border-[var(--app-border)]" data-review-file={file.path}>
    <div className="sticky top-0 flex min-w-0 items-center gap-2 bg-[var(--app-sidebar)] px-3 py-2">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm" aria-expanded={expanded} onClick={onToggle}>
        {expanded ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
        <span className="shrink-0 text-xs text-[var(--app-text-tertiary)]">{t(`status.${file.status}`, { defaultValue: file.status })}</span>
        <span className="truncate" title={file.path}>{file.path}</span>
        {file.oldPath && file.oldPath !== file.path && <span className="truncate text-xs text-[var(--app-text-tertiary)]">← {file.oldPath}</span>}
      </button>
      {file.diff && <span className="flex shrink-0 gap-2 font-mono text-xs tabular-nums" aria-label={t("fileStats")}>
        <span className="text-[var(--app-status-success)]">+{file.diff.stats.additions}</span>
        <span className="text-[var(--app-status-danger)]">-{file.diff.stats.deletions}</span>
      </span>}
      {file.canOpen && <button type="button" className="shrink-0 rounded p-1 hover:bg-[var(--app-hover)]" onClick={onOpen} aria-label={t("openFile", { path: file.path })} title={t("openCurrent")}><ExternalLink className="size-4" /></button>}
    </div>
    {expanded && <div className="min-h-16 border-t border-[var(--app-border)]">
      {file.error ? <p role="alert" className="p-3 text-sm text-[var(--app-status-danger)]">{file.error}</p>
        : file.previewOmitted ? <p className="p-3 text-sm text-[var(--app-text-tertiary)]">{t("previewOmitted")}</p>
          : <DiffView diff={file.diff ?? null} loading={pending} wrap={wrap} showStats={false} />}
    </div>}
  </article>;
}
