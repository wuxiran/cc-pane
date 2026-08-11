import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import {
  AlertCircle, CircleX, Clock3, Image, ListTodo, LoaderCircle,
  Pause, Play, RotateCcw, Send, Trash2, X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useTaskQueueStore } from "@/stores/useTaskQueueStore";
import type { StagedTaskQueueImage, TaskQueueItem, TaskQueueSnapshot } from "@/types/taskQueue";
import { clipboardHasImage } from "./terminalClipboard";

const QUICK_TASKS = ["Continue", "yes", "OK, continue", "/compact"] as const;
const MAX_DRAFT_IMAGES = 10;

function countLabel(count: number): string {
  return count > 9 ? "9+" : String(count);
}

function StatusIcon({ state }: { state: TaskQueueSnapshot["state"] }) {
  if (state === "paused") return <Pause className="size-3" aria-hidden="true" />;
  if (state === "actionRequired") return <AlertCircle className="size-3" aria-hidden="true" />;
  if (state === "sendFailed" || state === "sessionEnded") {
    return <CircleX className="size-3" aria-hidden="true" />;
  }
  if (state === "confirmingIdle" || state === "dispatching") {
    return <Clock3 className="size-3" aria-hidden="true" />;
  }
  return <ListTodo className="size-3" aria-hidden="true" />;
}

function QueueItemRow({ item, busy, onDelete, onRetry }: {
  item: TaskQueueItem;
  busy: boolean;
  onDelete: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation("panes");
  const retryable = item.state === "failed" || item.state === "deliveryUnknown";
  return (
    <li className="flex min-w-0 items-start gap-2 border-b border-[var(--app-border)] px-3 py-2 last:border-b-0">
      <span className="w-5 shrink-0 pt-0.5 text-right text-[10px] tabular-nums text-[var(--app-text-tertiary)]">
        {item.position + 1}
      </span>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 whitespace-pre-wrap break-words text-xs text-[var(--app-text-primary)]">
          {item.text || t("taskQueue.imageOnlyTask")}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--app-text-tertiary)]">
          <span>{t(`taskQueue.itemStates.${item.state}`)}</span>
          {item.imageRefs.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <Image className="size-3" aria-hidden="true" />{item.imageRefs.length}
            </span>
          )}
        </div>
      </div>
      {retryable && (
        <Button type="button" variant="ghost" size="icon-xs" aria-label={t("taskQueue.retry")}
          title={t("taskQueue.retry")} disabled={busy} onClick={onRetry}>
          <RotateCcw />
        </Button>
      )}
      <Button type="button" variant="ghost" size="icon-xs" aria-label={t("taskQueue.delete")}
        title={t("taskQueue.delete")} disabled={busy || item.state === "dispatching"} onClick={onDelete}>
        <Trash2 />
      </Button>
    </li>
  );
}

export default function TaskQueuePopover({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("panes");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftImages, setDraftImages] = useState<StagedTaskQueueImage[]>([]);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [confirmUnattended, setConfirmUnattended] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const draftImageSlotsRef = useRef(0);
  const snapshot = useTaskQueueStore((state) => state.snapshots.get(sessionId));
  const loading = useTaskQueueStore((state) => state.loadingSessions.has(sessionId));
  const busy = useTaskQueueStore((state) => state.mutatingSessions.has(sessionId));
  const requestError = useTaskQueueStore((state) => state.errors.get(sessionId));
  const load = useTaskQueueStore((state) => state.load);
  const addItem = useTaskQueueStore((state) => state.addItem);
  const deleteItem = useTaskQueueStore((state) => state.deleteItem);
  const clear = useTaskQueueStore((state) => state.clear);
  const update = useTaskQueueStore((state) => state.update);
  const retry = useTaskQueueStore((state) => state.retry);
  const stageClipboardImage = useTaskQueueStore((state) => state.stageClipboardImage);

  useEffect(() => {
    void load(sessionId).catch(() => undefined);
  }, [load, sessionId]);

  const run = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch {
      // The store retains a visible per-session error.
    }
  };

  const submitDraft = async (text = draft, imageRefs = draftImages.map((image) => image.imageRef)) => {
    if (!text.trim() && imageRefs.length === 0) return;
    const succeeded = await addItem(sessionId, { text, imageRefs }).then(() => true, () => false);
    if (succeeded && text === draft) {
      setDraft("");
      setDraftImages([]);
      draftImageSlotsRef.current = 0;
      setDraftError(null);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submitDraft();
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!clipboardHasImage(event.clipboardData)) return;
    event.preventDefault();
    if (draftImageSlotsRef.current >= MAX_DRAFT_IMAGES) {
      setDraftError(t("taskQueue.imageLimitReached"));
      return;
    }
    draftImageSlotsRef.current += 1;
    setDraftError(null);
    void stageClipboardImage(sessionId).then(
      (image) => setDraftImages((current) => [...current, image]),
      () => {
        draftImageSlotsRef.current -= 1;
        setDraftError(t("taskQueue.imageStageFailed"));
      },
    );
  };

  const itemCount = snapshot?.items.length ?? 0;
  const state = snapshot?.state ?? "running";
  const stateLabel = t(`taskQueue.states.${state}`);
  const visibleReason = snapshot?.reason
    ?? (snapshot && !snapshot.unattendedSupported ? "unattendedUnsupported" : null);
  const triggerLabel = t("taskQueue.triggerLabel", { count: itemCount, state: stateLabel });
  const hasHazardousItems = snapshot?.items.some(
    (item) => item.state === "failed" || item.state === "deliveryUnknown",
  ) ?? false;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button type="button" aria-label={triggerLabel}
                  className="relative inline-flex h-6 min-w-6 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-[10px] text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]">
                  <StatusIcon state={state} />
                  {itemCount > 0 && (
                    <Badge className="h-4 min-w-4 px-1 text-[9px] leading-none" variant="secondary">
                      {countLabel(itemCount)}
                    </Badge>
                  )}
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">{triggerLabel}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <PopoverContent side="top" align="end" sideOffset={6}
          className="flex max-h-[70vh] w-[min(420px,calc(100vw-16px))] flex-col overflow-hidden p-0"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}>
          <div className="flex items-start justify-between gap-3 border-b border-[var(--app-border)] px-3 py-2.5">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-[var(--app-text-primary)]">{t("taskQueue.title")}</h3>
              <p className="mt-0.5 text-[11px] text-[var(--app-text-tertiary)]">{t("taskQueue.description")}</p>
            </div>
            <Badge variant="outline" className="gap-1 text-[10px]"><StatusIcon state={state} />{stateLabel}</Badge>
          </div>

          <div className="flex items-center justify-between gap-2 border-b border-[var(--app-border)] px-3 py-2">
            <div className="flex items-center gap-1">
              <Button type="button" variant="outline" size="xs" disabled={!snapshot || busy}
                aria-label={snapshot?.paused ? t("taskQueue.resume") : t("taskQueue.pause")}
                onClick={() => void run(() => update(sessionId, { paused: !snapshot?.paused }))}>
                {snapshot?.paused ? <Play /> : <Pause />}
                {snapshot?.paused ? t("taskQueue.resume") : t("taskQueue.pause")}
              </Button>
              <Button type="button" variant="ghost" size="xs" disabled={itemCount === 0 || busy}
                onClick={() => hasHazardousItems ? setConfirmClear(true) : void run(() => clear(sessionId))}>
                <Trash2 />{t("taskQueue.clear")}
              </Button>
            </div>
            <label className="flex items-center gap-2 text-[11px] text-[var(--app-text-secondary)]">
              {t("taskQueue.unattended")}
              <Switch aria-label={t("taskQueue.unattended")} checked={snapshot?.unattended ?? false}
                disabled={!snapshot?.unattendedSupported || busy}
                onCheckedChange={(checked) => checked
                  ? setConfirmUnattended(true)
                  : void run(() => update(sessionId, { unattended: false }))} />
            </label>
          </div>

          {visibleReason && (
            <div className="flex items-start gap-2 border-b border-[var(--app-border)] bg-[var(--app-hover)] px-3 py-2 text-[11px] text-[var(--app-text-secondary)]">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {t(`taskQueue.reasons.${visibleReason}`)}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading && !snapshot ? (
              <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-[var(--app-text-tertiary)]">
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />{t("taskQueue.loading")}
              </div>
            ) : itemCount === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-[var(--app-text-tertiary)]">{t("taskQueue.empty")}</p>
            ) : (
              <ol>{snapshot?.items.map((item) => (
                <QueueItemRow key={item.id} item={item} busy={busy}
                  onDelete={() => void run(() => deleteItem(sessionId, item.id))}
                  onRetry={() => void run(() => retry(sessionId, item.id))} />
              ))}</ol>
            )}
          </div>

          <div className="space-y-2 border-t border-[var(--app-border)] p-3">
            {draftImages.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {draftImages.map((image) => (
                  <span key={image.imageRef} className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--app-border)] px-2 text-[10px] text-[var(--app-text-secondary)]">
                    <Image className="size-3" aria-hidden="true" />{image.width} x {image.height}
                    <button type="button" aria-label={t("taskQueue.removeImage")}
                      className="ml-0.5 rounded p-0.5 hover:bg-[var(--app-hover)]"
                      onClick={() => {
                        draftImageSlotsRef.current = Math.max(0, draftImageSlotsRef.current - 1);
                        setDraftImages((current) => current.filter((entry) => entry.imageRef !== image.imageRef));
                      }}>
                      <X className="size-3" aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <textarea ref={inputRef} rows={3} aria-label={t("taskQueue.newTask")}
                placeholder={t("taskQueue.placeholder")} value={draft}
                onChange={(event) => setDraft(event.target.value)} onKeyDown={handleKeyDown} onPaste={handlePaste}
                className="min-h-16 min-w-0 flex-1 resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-content)] px-2.5 py-2 text-xs text-[var(--app-text-primary)] outline-none focus:border-[var(--app-accent)]" />
              <Button type="button" size="icon-sm" aria-label={t("taskQueue.add")}
                disabled={busy || (!draft.trim() && draftImages.length === 0)} onClick={() => void submitDraft()}>
                <Send />
              </Button>
            </div>
            <div className="flex flex-wrap gap-1">
              {QUICK_TASKS.map((task) => (
                <Button key={task} type="button" variant="ghost" size="xs" disabled={busy}
                  onClick={() => void submitDraft(task, [])}>{task}</Button>
              ))}
            </div>
            {(draftError || requestError) && (
              <p role="alert" className="text-[11px] text-[var(--app-status-error)]">
                {draftError || t("taskQueue.operationFailed", { error: requestError })}
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>

      <Dialog open={confirmUnattended} onOpenChange={setConfirmUnattended}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("taskQueue.unattendedConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("taskQueue.unattendedConfirmDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmUnattended(false)}>{t("taskQueue.cancel")}</Button>
            <Button onClick={() => {
              setConfirmUnattended(false);
              void run(() => update(sessionId, { unattended: true }));
            }}>{t("taskQueue.enableUnattended")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("taskQueue.clearConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("taskQueue.clearConfirmDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClear(false)}>{t("taskQueue.cancel")}</Button>
            <Button variant="destructive" onClick={() => {
              setConfirmClear(false);
              void run(() => clear(sessionId));
            }}>{t("taskQueue.clearConfirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
