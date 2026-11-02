import "@/i18n/browserAnnotationResources";
import { useMemo, useState } from "react";
import { Copy, Image, LoaderCircle, Save, Send, Trash2, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { usePanesStore } from "@/stores/usePanesStore";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { copyAnnotationImage, copyAnnotationReference } from "@/services/browserAnnotationService";
import AnnotationSurface from "@/components/browser/annotations/AnnotationSurface";
import { MAX_ANNOTATIONS, MAX_NOTE_LENGTH } from "@/components/browser/annotations/annotationModel";
import { addAnnotationToDraft, annotationChatTargets } from "@/components/browser/annotations/annotationDraft";
import { useAnnotationDocument } from "@/components/browser/annotations/useAnnotationDocument";

export default function BrowserAnnotationPanel({ tabId, url, title, onClose }: {
  tabId: string; url: string; title?: string; onClose: () => void;
}) {
  const { t } = useTranslation("browserAnnotations");
  const document = useAnnotationDocument(tabId);
  const [target, setTarget] = useState("");
  const root = usePanesStore((state) => state.rootPane);
  const layouts = usePanesStore((state) => state.layouts);
  const currentLayoutId = usePanesStore((state) => state.currentLayoutId);
  const activePaneId = usePanesStore((state) => state.activePaneId);
  const chats = useAgentChatStore((state) => state.chats);
  const targets = useMemo(() => annotationChatTargets({ rootPane: root, layouts, currentLayoutId, activePaneId }).filter((tab) => chats[tab.id]?.snapshot), [root, layouts, currentLayoutId, activePaneId, chats]);
  const close = () => { if (!document.busy && (!document.dirty || window.confirm(t("discard")))) onClose(); };
  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent className="flex h-[90vh] w-[96vw] flex-col gap-3 overflow-hidden rounded-2xl bg-[var(--app-content)] sm:max-w-[1440px]">
      <DialogHeader className="pr-8"><DialogTitle>{t("title")}</DialogTitle><DialogDescription className="truncate">{document.frame?.title || title || url}</DialogDescription></DialogHeader>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={document.loading || document.busy || !document.annotations.length} onClick={() => document.setAnnotations((items) => items.slice(0, -1))}><Undo2 className="size-4" />{t("undo")}</Button>
        <Button size="sm" disabled={document.loading || document.busy || !document.frame} onClick={() => void document.perform(undefined, t("saved"))}><Save className="size-4" />{t("save")}</Button>
        <Button size="sm" variant="outline" disabled={document.loading || document.busy || !document.frame} onClick={() => void document.perform((value) => copyAnnotationReference(value.markdown), t("referenceCopied"))}><Copy className="size-4" />{t("copyReference")}</Button>
        <Button size="sm" variant="outline" disabled={document.loading || document.busy || !document.frame} onClick={() => void document.perform((value) => copyAnnotationImage(value.dataUrl), t("imageCopied"))}><Image className="size-4" />{t("copyImage")}</Button>
        {document.busy && <LoaderCircle className="size-4 animate-spin" />}
      </div>
      <p className="text-xs text-[var(--app-text-tertiary)]">{t("hint")}</p>
      {document.error && <p role="alert" className="text-sm text-[var(--app-status-danger)]">{document.error}</p>}
      {document.notice && <p role="status" className="text-xs text-[var(--app-status-success)]">{document.notice}</p>}
      {document.loading && <div className="flex flex-1 items-center justify-center gap-2 text-sm"><LoaderCircle className="size-4 animate-spin" />{t("capturing")}</div>}
      {document.frame && <div className="flex min-h-0 flex-1 flex-col gap-3 sm:flex-row">
        <div className="min-h-0 min-w-0 flex-1 overflow-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-sidebar)]">
          <AnnotationSurface frame={document.frame} annotations={document.annotations} disabled={document.busy} onAdd={(rect) => document.setAnnotations((items) => items.length < MAX_ANNOTATIONS ? [...items, { ...rect, id: crypto.randomUUID(), note: "" }] : items)} />
        </div>
        <div className="flex min-h-0 w-full flex-col gap-3 sm:w-72 sm:shrink-0">
          <div className="flex items-center justify-between text-xs font-medium"><span>{t("notes", { count: document.annotations.length })}</span><span className="text-[var(--app-text-tertiary)]">{document.annotations.length}/{MAX_ANNOTATIONS}</span></div>
          <div className="min-h-0 flex-1 space-y-3 overflow-auto">
            {!document.annotations.length && <p className="py-4 text-xs text-[var(--app-text-tertiary)]">{t("empty")}</p>}
            {document.annotations.map((item, index) => <div key={item.id} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-sidebar)] p-3">
              <div className="mb-2 flex items-center justify-between text-xs"><label htmlFor={`annotation-${item.id}`}>{t("noteNumber", { number: index + 1 })}</label><button type="button" disabled={document.busy} aria-label={t("remove", { number: index + 1 })} onClick={() => document.setAnnotations((items) => items.filter((entry) => entry.id !== item.id))}><Trash2 className="size-3.5" /></button></div>
              <textarea id={`annotation-${item.id}`} value={item.note} maxLength={MAX_NOTE_LENGTH} disabled={document.busy} onChange={(event) => document.setAnnotations((items) => items.map((entry) => entry.id === item.id ? { ...entry, note: event.target.value } : entry))} rows={3} placeholder={t("notePlaceholder")} className="w-full resize-y rounded-lg border border-[var(--app-border)] bg-[var(--app-content)] p-2 text-xs" />
            </div>)}
          </div>
          <div className="space-y-2 border-t border-[var(--app-border)] pt-3"><select aria-label={t("draftTarget")} value={target} onChange={(event) => setTarget(event.target.value)} className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-content)] p-2 text-xs"><option value="">{t("chooseAgent")}</option>{targets.map((tab) => <option key={tab.id} value={tab.id}>{tab.title}</option>)}</select>
            <Button size="sm" variant="outline" className="w-full" disabled={!target || !targets.some((tab) => tab.id === target) || document.busy} onClick={() => void document.perform((value) => addAnnotationToDraft(target, value), t("addedToDraft"))}><Send className="size-3.5" />{t("addToDraft")}</Button><p className="text-xs text-[var(--app-text-tertiary)]">{t("draftHint")}</p></div>
        </div>
      </div>}
      {document.saved && <p className="truncate text-xs text-[var(--app-text-tertiary)]" title={document.saved.filePath}>{document.saved.filePath}</p>}
    </DialogContent>
  </Dialog>;
}
