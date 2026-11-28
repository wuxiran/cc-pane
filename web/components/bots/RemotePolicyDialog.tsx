// 按 Bot 的远程权限（docs/112 §5.3）：是否对其他设备可见 + 四档权限。
// full = 最高权限（远程回合全部自动放行），选中时红色警示并二次确认。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { toastErr, toastOk } from "@/lib/feedback";
import { botMeshService } from "@/services/botMeshService";
import { nativeConfirm } from "@/services/nativeDialog";
import { REMOTE_POLICIES, type BotSummary, type RemotePolicy } from "@/types/bot";

/** allowlist 可选的 ACP ToolKind。 */
export const ALLOW_KINDS = ["read", "search", "fetch", "edit", "execute", "other"] as const;

interface RemotePolicyDialogProps {
  bot: BotSummary | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function RemotePolicyDialog({ bot, onClose, onSaved }: RemotePolicyDialogProps) {
  const { t } = useTranslation("sidebar");
  const [shared, setShared] = useState(true);
  const [policy, setPolicy] = useState<RemotePolicy>("ask_origin");
  const [kinds, setKinds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!bot) return;
    setShared(bot.remoteShared ?? true);
    setPolicy(bot.remotePolicy ?? "ask_origin");
    setKinds(bot.remoteAllowKinds ?? []);
  }, [bot]);

  if (!bot) return null;

  const toggleKind = (kind: string) =>
    setKinds((current) => (current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind]));

  const save = async () => {
    const upgradingToFull = policy === "full" && bot.remotePolicy !== "full";
    if (upgradingToFull) {
      const ok = await nativeConfirm(t("bots.mesh.fullConfirm", { name: bot.name }), { kind: "warning" });
      if (!ok) return;
    }
    setSaving(true);
    try {
      await botMeshService.setBotRemote(bot.id, {
        remoteShared: shared,
        remotePolicy: policy,
        remoteAllowKinds: kinds,
        confirmFull: upgradingToFull,
      });
      toastOk(t("bots.mesh.policySaved"));
      onSaved();
    } catch (error) {
      toastErr(String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg" data-testid="bot-remote-policy">
        <DialogHeader>
          <DialogTitle>{t("bots.mesh.policyTitle", { name: bot.name })}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-[length:var(--text-small)]">
          <label className="flex items-center justify-between gap-3">
            <span>
              {t("bots.mesh.shared")}
              <span className="block text-[length:var(--text-micro)] text-[var(--app-text-muted)]">{t("bots.mesh.sharedHint")}</span>
            </span>
            <Switch checked={shared} onCheckedChange={setShared} aria-label={t("bots.mesh.shared")} />
          </label>
          <div role="radiogroup" aria-label={t("bots.mesh.policy")} className="flex flex-col gap-1.5">
            {REMOTE_POLICIES.map((level) => {
              const danger = level === "full";
              const checked = policy === level;
              return (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  disabled={!shared}
                  data-testid={`remote-policy-${level}`}
                  onClick={() => setPolicy(level)}
                  className="flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors disabled:opacity-50"
                  style={{
                    borderColor: checked ? (danger ? "var(--app-status-danger)" : "var(--app-accent)") : "var(--app-border)",
                    background: checked && danger ? "color-mix(in srgb, var(--app-status-danger) 10%, transparent)" : undefined,
                  }}
                >
                  <span className="flex items-center gap-1.5 font-medium" style={danger ? { color: "var(--app-status-danger)" } : undefined}>
                    {danger && <ShieldAlert className="h-3.5 w-3.5" />}
                    {t(`bots.mesh.level.${level}`)}
                  </span>
                  <span className="text-[length:var(--text-micro)] text-[var(--app-text-muted)]">{t(`bots.mesh.levelHint.${level}`)}</span>
                </button>
              );
            })}
          </div>
          {policy === "allowlist" && shared && (
            <div className="flex flex-wrap gap-2" data-testid="remote-allow-kinds">
              {ALLOW_KINDS.map((kind) => (
                <label key={kind} className="flex items-center gap-1">
                  <input type="checkbox" checked={kinds.includes(kind)} onChange={() => toggleKind(kind)} />
                  {t(`bots.mesh.kind.${kind}`)}
                </label>
              ))}
            </div>
          )}
          {policy === "full" && shared && (
            <div
              role="alert"
              className="rounded-md border px-3 py-2 text-[length:var(--text-micro)]"
              style={{ borderColor: "var(--app-status-danger)", color: "var(--app-status-danger)" }}
            >
              {t("bots.mesh.fullWarning")}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("bots.cancel")}</Button>
          <Button disabled={saving} onClick={() => void save()}>{t("bots.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
