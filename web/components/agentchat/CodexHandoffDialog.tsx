import "@/i18n/codexIntegrationResources";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { codexDesktopService } from "@/services/codexDesktopService";
import { useAgentChatDraftStore } from "@/stores/useAgentChatDraftStore";
import { translateError } from "@/utils/errorTranslation";

export default function CodexHandoffDialog({ cwd, chatId, onClose }: { cwd: string; chatId?: string; onClose: () => void }) {
  const { t } = useTranslation("codexIntegration");
  const [prompt, setPrompt] = useState(() => chatId ? useAgentChatDraftStore.getState().drafts[chatId]?.text ?? "" : "");
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const valid = prompt.trim().length > 0 && new TextEncoder().encode(prompt).byteLength <= 8192;
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
