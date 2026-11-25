import "@/i18n/codexIntegrationResources";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Quote } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { codexDesktopService } from "@/services/codexDesktopService";
import { useAgentChatDraftStore } from "@/stores/useAgentChatDraftStore";
import { translateError } from "@/utils/errorTranslation";
import { isHandoffPromptValid, quoteForHandoff, utf8Bytes } from "./codexHandoffPrompt";

/** selection：打开前捕获的 transcript 选区，存在时作为引用块预填；lastReply：「引用最后一条回复」的来源。 */
export default function CodexHandoffDialog({ cwd, chatId, selection, lastReply, onClose }: {
  cwd: string; chatId?: string; selection?: string; lastReply?: string; onClose: () => void;
}) {
  const { t } = useTranslation("codexIntegration");
  const [initial] = useState(() => selection?.trim() ? quoteForHandoff(selection) : null);
  const [prompt, setPrompt] = useState(() => initial?.text || (chatId ? useAgentChatDraftStore.getState().drafts[chatId]?.text ?? "" : ""));
  const [truncated, setTruncated] = useState(initial?.truncated ?? false);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const valid = isHandoffPromptValid(prompt);
  function quoteLastReply() {
    if (!lastReply) return;
    const quoted = quoteForHandoff(lastReply, utf8Bytes(prompt));
    setPrompt(quoted.text + prompt);
    setTruncated(quoted.truncated);
  }
  async function handoff() {
    if (!valid || pending.current || opened) return;
    pending.current = true; setBusy(true); setError("");
    try {
      // Always a new desktop draft. Never discard prompt by sending it to a thread URL.
      await codexDesktopService.open({ cwd, prompt });
      setOpened(true);
    } catch (cause) { setError(translateError(cause)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="max-w-xl rounded-2xl" onInteractOutside={(event) => { if (busy) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>{t("handoff")}</DialogTitle><DialogDescription>{t("handoffHint")}</DialogDescription></DialogHeader>
      <p className="truncate text-xs text-muted-foreground" title={cwd}>{cwd}</p>
      <Textarea aria-label={t("taskLabel")} placeholder={t("taskPlaceholder")} className="min-h-44 resize-y" value={prompt} disabled={busy || opened} onChange={(event) => setPrompt(event.target.value)} />
      {lastReply?.trim() && !opened && <div className="flex justify-start">
        <Button variant="outline" size="sm" disabled={busy} onClick={quoteLastReply}><Quote className="size-3.5" />{t("quoteLastReply")}</Button>
      </div>}
      {truncated && valid && <p aria-live="polite" className="text-xs text-[var(--app-tag-amber)]">{t("quoteTruncated")}</p>}
      {!valid && prompt.trim() && <p role="alert" className="text-xs text-destructive">{t("taskTooLong")}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {opened && <p role="status" className="text-sm text-muted-foreground">{t("awaitingSend")}</p>}
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onClose}>{opened ? t("done") : t("cancel")}</Button>
        {!opened && <Button disabled={!valid || busy} onClick={() => void handoff()}><ExternalLink className="size-4" />{busy ? t("opening") : t("openDraft")}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
