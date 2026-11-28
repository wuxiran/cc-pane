// 「导出到手机」（docs/112 §6）：勾选供应商 → 生成 6 位一次性导出码（5 分钟、单次）→
// 手机在已配对连接上输入码领取（含密钥）。密钥从不经过本界面；候选只显示「有无密钥」。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CheckboxRow } from "@/components/ui/CheckboxRow";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toastErr, toastOk } from "@/lib/feedback";
import { providerExportService } from "@/services/providerExportService";
import type { ProviderExportCandidate, ProviderExportTicket } from "@/types/providerExport";

interface ProviderExportDialogProps {
  open: boolean;
  onClose: () => void;
}

const PROTOCOL_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai_chat: "OpenAI",
};

function secondsLeft(expiresAt: string, now: number): number {
  return Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
}

export default function ProviderExportDialog({ open, onClose }: ProviderExportDialogProps) {
  const { t } = useTranslation(["settings", "common"]);
  const [candidates, setCandidates] = useState<ProviderExportCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ticket, setTicket] = useState<ProviderExportTicket | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCandidates(null);
    setTicket(null);
    providerExportService
      .candidates()
      .then((list) => {
        if (cancelled) return;
        setCandidates(list);
        setSelected(new Set(list.filter((c) => !c.unsupportedReason).map((c) => c.id)));
      })
      .catch((error) => {
        if (!cancelled) toastErr(t("providerExport.loadFailed", { error: String(error) }));
      });
    return () => {
      cancelled = true;
    };
  }, [open, t]);

  // 码的倒计时 + 手机领取 / 码作废的事件。
  useEffect(() => {
    if (!ticket) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void providerExportService
      .listen((event) => {
        if (event.state === "redeemed") {
          toastOk(t("providerExport.redeemed", { device: event.device ?? "", count: event.count ?? 0 }));
          setTicket(null);
          onClose();
        } else {
          toastErr(t("providerExport.cancelled"));
          setTicket(null);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      unlisten?.();
    };
  }, [ticket, onClose, t]);

  const exportable = useMemo(
    () => (candidates ?? []).filter((c) => !c.unsupportedReason),
    [candidates],
  );
  const remaining = ticket ? secondsLeft(ticket.expiresAt, now) : 0;
  const expired = ticket !== null && remaining === 0;

  const toggle = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleStart = async () => {
    setBusy(true);
    try {
      setTicket(await providerExportService.start([...selected]));
      setNow(Date.now());
    } catch (error) {
      toastErr(t("providerExport.startFailed", { error: String(error) }));
    } finally {
      setBusy(false);
    }
  };

  const handleClose = () => {
    if (ticket) void providerExportService.cancel().catch(() => undefined);
    setTicket(null);
    onClose();
  };

  const reasonLabel = (reason: string) =>
    reason === "NO_API_KEY" ? t("providerExport.reasonNoKey") : t("providerExport.reasonUnsupported");

  return (
    <Dialog open={open} onOpenChange={(next) => !next && handleClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone size={16} />
            {t("providerExport.title")}
          </DialogTitle>
          <DialogDescription>{t("providerExport.description")}</DialogDescription>
        </DialogHeader>

        {ticket ? (
          <div className="flex flex-col items-center gap-3 py-4" data-testid="provider-export-code">
            <div
              className="font-mono text-4xl font-semibold tracking-[0.3em]"
              style={{ color: expired ? "var(--app-text-tertiary)" : "var(--app-text-primary)" }}
            >
              {ticket.code}
            </div>
            <div className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>
              {expired
                ? t("providerExport.expired")
                : t("providerExport.codeHint", {
                    count: ticket.providerCount,
                    minutes: Math.floor(remaining / 60),
                    seconds: String(remaining % 60).padStart(2, "0"),
                  })}
            </div>
            <div className="text-xs text-center" style={{ color: "var(--app-text-secondary)" }}>
              {t("providerExport.phoneSteps")}
            </div>
          </div>
        ) : candidates === null ? (
          <div className="flex justify-center py-6">
            <Loader2 className="animate-spin" size={18} />
          </div>
        ) : (
          <div className="flex max-h-[50vh] flex-col gap-1.5 overflow-y-auto">
            {candidates.length === 0 && (
              <div className="py-4 text-center text-sm" style={{ color: "var(--app-text-tertiary)" }}>
                {t("providerExport.empty")}
              </div>
            )}
            {candidates.map((c) => (
              <CheckboxRow
                key={c.id}
                checked={selected.has(c.id)}
                disabled={Boolean(c.unsupportedReason)}
                onCheckedChange={(checked) => toggle(c.id, checked)}
                label={c.name}
                description={
                  c.unsupportedReason
                    ? reasonLabel(c.unsupportedReason)
                    : [c.protocol ? PROTOCOL_LABEL[c.protocol] : "", c.baseUrl ?? ""].filter(Boolean).join(" · ")
                }
              />
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {ticket ? t("providerExport.done") : t("common:cancel")}
          </Button>
          {(!ticket || expired) && (
            <Button
              disabled={busy || selected.size === 0 || exportable.length === 0}
              onClick={() => void handleStart()}
            >
              {busy && <Loader2 className="animate-spin" size={14} />}
              {expired ? t("providerExport.regenerate") : t("providerExport.generate", { count: selected.size })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
