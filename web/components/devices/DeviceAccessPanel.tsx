// 设置 → Web 访问 → 其他设备：允许其他电脑上的 CC-Panes 连接本机（docs/111 阶段 4）。
// 开关随设置表单一起保存；配对码与已配对设备列表即时生效。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Copy, KeyRound, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  cancelDevicePairing,
  listDeviceAccess,
  revokeDeviceAccess,
  startDevicePairing,
  type DeviceAccessRecord,
  type PairingInfo,
} from "@/services/deviceService";
import { nativeConfirm } from "@/services/nativeDialog";
import { useSettingsStore } from "@/stores";
import { getErrorMessage } from "@/utils";

interface DeviceAccessPanelProps {
  allowDevices: boolean;
  onAllowDevicesChange: (allow: boolean) => void;
}

function secondsLeft(expiresAt: string): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

export default function DeviceAccessPanel({ allowDevices, onAllowDevicesChange }: DeviceAccessPanelProps) {
  const { t } = useTranslation("sidebar");
  // 配对码由正在运行的 Web 服务兑换：只有「已保存」的开关才算数。
  const savedAllowDevices = useSettingsStore((s) => Boolean(s.settings?.webAccess.allowDevices));
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [starting, setStarting] = useState(false);
  const [records, setRecords] = useState<DeviceAccessRecord[]>([]);

  const reload = useCallback(async () => {
    try {
      setRecords((await listDeviceAccess()) ?? []);
    } catch {
      // 列表只是展示用，读不到不影响设置页其余部分
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!pairing) return;
    setRemaining(secondsLeft(pairing.expiresAt));
    const timer = window.setInterval(() => {
      const left = secondsLeft(pairing.expiresAt);
      setRemaining(left);
      // 对方配对成功后配对码作废，同时刷新已配对列表
      void reload();
      if (left === 0) setPairing(null);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [pairing, reload]);

  const start = async () => {
    setStarting(true);
    try {
      setPairing(await startDevicePairing());
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    setPairing(null);
    await cancelDevicePairing().catch(() => {});
  };

  const revoke = async (record: DeviceAccessRecord) => {
    if (!(await nativeConfirm(t("devices.access.revokeConfirm", { name: record.name })))) return;
    try {
      await revokeDeviceAccess(record.id);
      await reload();
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => toast.success(t("devices.access.copied")));
  };

  return (
    <div className="flex flex-col gap-2 pt-3" style={{ borderTop: "1px solid var(--app-border)" }} data-testid="device-access-panel">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label htmlFor="web-access-allow-devices">{t("devices.access.title")}</Label>
          <p className="m-0 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
            {t("devices.access.description")}
          </p>
        </div>
        <input
          id="web-access-allow-devices"
          type="checkbox"
          checked={allowDevices}
          onChange={(event) => onAllowDevicesChange(event.target.checked)}
          className="h-4 w-4 cursor-default"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      {allowDevices && !savedAllowDevices && (
        <p className="m-0 text-xs" style={{ color: "var(--app-status-warning)" }}>{t("devices.access.saveFirst")}</p>
      )}

      {savedAllowDevices && (
        pairing && remaining > 0 ? (
          <div className="flex flex-col gap-1.5 rounded-lg border px-3 py-2" style={{ borderColor: "var(--app-border)" }}>
            <div className="flex items-center justify-between">
              <span className="font-mono text-2xl font-semibold tracking-[0.35em]" style={{ color: "var(--app-text-primary)" }} data-testid="device-pairing-code-display">
                {pairing.code}
              </span>
              <div className="flex items-center gap-2 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                {t("devices.access.expiresIn", { minutes: Math.floor(remaining / 60), seconds: String(remaining % 60).padStart(2, "0") })}
                <button type="button" aria-label={t("devices.access.cancel")} onClick={() => void cancel()}>
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <p className="m-0 text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("devices.access.addressHint")}</p>
            {pairing.addresses.length === 0 ? (
              <p className="m-0 text-xs" style={{ color: "var(--app-status-warning)" }}>{t("devices.access.noAddress")}</p>
            ) : pairing.addresses.map((address) => (
              <div key={address} className="flex items-center gap-2 text-xs">
                <code style={{ color: "var(--app-text-primary)" }}>{address}</code>
                <button type="button" aria-label={t("devices.access.copy")} onClick={() => copy(address)}>
                  <Copy className="h-3 w-3" style={{ color: "var(--app-text-tertiary)" }} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <Button type="button" size="sm" variant="outline" className="self-start" disabled={starting} onClick={() => void start()}>
            {starting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <KeyRound className="mr-1 h-3.5 w-3.5" />}
            {t("devices.access.generate")}
          </Button>
        )
      )}

      {records.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium" style={{ color: "var(--app-text-secondary)" }}>{t("devices.access.paired")}</span>
          {records.map((record) => (
            <div key={record.id} className="flex items-center gap-2 text-xs">
              <span className="truncate" style={{ color: "var(--app-text-primary)" }}>{record.name}</span>
              <code className="shrink-0" style={{ color: "var(--app-text-tertiary)" }}>{record.hint}…</code>
              <span className="shrink-0" style={{ color: "var(--app-text-tertiary)" }}>
                {new Date(record.createdAt).toLocaleDateString()}
              </span>
              <button
                type="button"
                className="ml-auto shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-[var(--app-hover)]"
                style={{ color: "var(--app-status-danger)" }}
                onClick={() => void revoke(record)}
              >
                {t("devices.access.revoke")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
