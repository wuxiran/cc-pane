// 「已授权的客户端」的两个小部件：配对时的令牌有效期下拉、撤销其他全部。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldOff } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SettingsRow } from "@/components/settings/layout";
import { revokeOtherAccess } from "@/services/accessService";
import { nativeConfirm } from "@/services/nativeDialog";
import { getErrorMessage } from "@/utils";
import { PAIRING_TTL_OPTIONS, type PairingTtl } from "./deviceAccessFormat";

export function PairingTtlSelect({ value, onChange }: { value: PairingTtl; onChange: (ttl: PairingTtl) => void }) {
  const { t } = useTranslation("settings");
  const label = (ttl: PairingTtl) => (ttl === 0
    ? t("deviceAccess.expiry.never")
    : t("deviceAccess.expiry.days", { count: ttl }));
  return (
    <Select value={String(value)} onValueChange={(next) => onChange(Number(next) as PairingTtl)}>
      <SelectTrigger size="sm" className="h-7 w-auto gap-1 text-[length:var(--text-small)]" aria-label={t("deviceAccess.expiry.label")}>
        <span className="text-[var(--app-text-tertiary)]">{t("deviceAccess.expiry.label")}</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PAIRING_TTL_OPTIONS.map((ttl) => (
          <SelectItem key={ttl} value={String(ttl)}>{label(ttl)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface RevokeOthersRowProps {
  /** 将被移除的已配对设备数 */
  deviceCount: number;
  /** 将被注销的网页登录会话数（不含发起操作的会话） */
  sessionCount: number;
  onDone: () => void;
}

export function RevokeOthersRow({ deviceCount, sessionCount, onDone }: RevokeOthersRowProps) {
  const { t } = useTranslation("settings");
  const [busy, setBusy] = useState(false);
  const nothing = deviceCount + sessionCount === 0;

  const run = async () => {
    const message = t("deviceAccess.revokeOthers.confirm", { devices: deviceCount, sessions: sessionCount });
    if (!(await nativeConfirm(message))) return;
    setBusy(true);
    try {
      const result = await revokeOtherAccess();
      toast.success(t("deviceAccess.revokeOthers.done", {
        devices: result.deviceTokens,
        sessions: result.webSessions,
      }));
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(false);
      onDone();
    }
  };

  return (
    <SettingsRow
      icon={ShieldOff}
      title={t("deviceAccess.revokeOthers.title")}
      description={nothing ? t("deviceAccess.revokeOthers.nothing") : t("deviceAccess.revokeOthers.description")}
      control={(
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="text-[var(--app-status-danger)]"
          disabled={nothing || busy}
          onClick={() => void run()}
          data-testid="device-access-revoke-others"
        >
          {t("deviceAccess.revokeOthers.button")}
        </Button>
      )}
    />
  );
}
