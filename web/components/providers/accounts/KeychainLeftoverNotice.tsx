import { useTranslation } from "react-i18next";
import { Copy, KeyRound, X } from "lucide-react";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { toastOk } from "@/lib/feedback";

interface KeychainLeftoverNoticeProps {
  /** 清除凭据的命令（带着被删账号的目录变量）；后端没给时只提示。 */
  logoutCommand?: string;
  onDismiss: () => void;
}

/** 删掉的登录账号，凭据可能还在系统钥匙串里：CC-Panes 不删别的程序的钥匙串条目，提示用户用 logout 清除。 */
export default function KeychainLeftoverNotice({ logoutCommand, onDismiss }: KeychainLeftoverNoticeProps) {
  const { t } = useTranslation("providers");
  const copy = () => {
    if (!logoutCommand) return;
    void navigator.clipboard?.writeText(logoutCommand).catch(() => undefined);
    toastOk(t("providerAccounts.remove.commandCopied"));
  };
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
      style={{
        borderColor: "var(--app-status-warning)",
        background: "color-mix(in srgb, var(--app-status-warning) 8%, transparent)",
        color: "var(--app-text-secondary)",
      }}
    >
      <KeyRound size={13} className="mt-0.5 shrink-0" style={{ color: "var(--app-status-warning)" }} />
      <div className="min-w-0 flex-1">
        <p>{t("providerAccounts.remove.keychainBody")}</p>
        {logoutCommand ? (
          <div className="mt-1.5 flex items-center gap-1.5">
            <code
              data-testid="logout-command"
              className="min-w-0 flex-1 break-all rounded px-1.5 py-1 font-mono text-[length:var(--text-caption)]"
              style={{ background: "var(--app-panel-bg)", color: "var(--app-text-primary)" }}
            >
              {logoutCommand}
            </code>
            <IconTooltipButton label={t("providerAccounts.remove.copyCommand")} className="h-7 w-7" onClick={copy}>
              <Copy size={13} />
            </IconTooltipButton>
          </div>
        ) : (
          <p className="mt-1">{t("providerAccounts.remove.keychainNoCommand")}</p>
        )}
      </div>
      <IconTooltipButton label={t("providerAccounts.remove.dismiss")} className="h-6 w-6" onClick={onDismiss}>
        <X size={12} />
      </IconTooltipButton>
    </div>
  );
}
