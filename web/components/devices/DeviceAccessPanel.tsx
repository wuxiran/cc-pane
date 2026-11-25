// 设置 → 设备与访问 → 已授权的客户端：允许其他电脑上的 CC-Panes 连接本机（docs/111 阶段 4）。
// 开关随设置表单一起保存；配对码与已配对设备列表即时生效。每台已配对设备一行，可单独移除。
// 第二个列表是网页登录会话；底部「撤销其他全部」一次清掉设备令牌与网页会话。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/toast";
import { Copy, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  SettingsBlock,
  SettingsHint,
  SettingsSection,
  SettingsSwitchRow,
} from "@/components/settings/layout";
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
import DevicePairingQr from "./DevicePairingQr";
import DeviceAccessRow from "./DeviceAccessRow";
import WebSessionsList, { useWebSessions } from "./WebSessionsList";
import { PairingTtlSelect, RevokeOthersRow } from "./DeviceAccessExtras";
import { DEFAULT_PAIRING_TTL, type PairingTtl } from "./deviceAccessFormat";
import { getErrorMessage } from "@/utils";

interface DeviceAccessPanelProps {
  allowDevices: boolean;
  onAllowDevicesChange: (allow: boolean) => void;
}

function secondsLeft(expiresAt: string): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

export default function DeviceAccessPanel({ allowDevices, onAllowDevicesChange }: DeviceAccessPanelProps) {
  const { t } = useTranslation(["sidebar", "settings"]);
  // 配对码由正在运行的 Web 服务兑换：只有「已保存」的开关才算数。
  const savedAllowDevices = useSettingsStore((s) => Boolean(s.settings?.webAccess.allowDevices));
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [starting, setStarting] = useState(false);
  const [records, setRecords] = useState<DeviceAccessRecord[]>([]);
  const [ttl, setTtl] = useState<PairingTtl>(DEFAULT_PAIRING_TTL);
  const [now, setNow] = useState(() => Date.now());
  const webSessions = useWebSessions();

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

  // 在线状态 / 「x 分钟前」随时间变化：每 30 秒刷新一次列表与当前时间
  const reloadWebSessions = webSessions.reload;
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void reload();
      void reloadWebSessions();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [reload, reloadWebSessions]);

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
      setPairing(await startDevicePairing(ttl));
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

  const canPair = savedAllowDevices && !(pairing && remaining > 0);

  return (
    <SettingsSection
      data-testid="device-access-panel"
      sectionId="web-access-clients"
      title={t("settings:deviceAccess.clientsTitle")}
      description={t("settings:deviceAccess.clientsDescription")}
      actions={canPair ? (
        <>
          <PairingTtlSelect value={ttl} onChange={setTtl} />
          <Button type="button" size="sm" variant="ghost" disabled={starting} onClick={() => void start()}>
            {starting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-1 h-3.5 w-3.5" />}
            {t("devices.access.createPairing")}
          </Button>
        </>
      ) : undefined}
    >
      <SettingsSwitchRow
        id="web-access-allow-devices"
        title={t("devices.access.title")}
        description={t("devices.access.description")}
        checked={allowDevices}
        onCheckedChange={onAllowDevicesChange}
      >
        {allowDevices && !savedAllowDevices ? (
          <SettingsHint className="text-[var(--app-status-warning)]">{t("devices.access.saveFirst")}</SettingsHint>
        ) : null}
      </SettingsSwitchRow>

      {savedAllowDevices && pairing && remaining > 0 ? (
        <SettingsBlock className="flex items-start gap-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="font-mono text-2xl font-semibold tracking-[0.35em] text-[var(--app-text-primary)]" data-testid="device-pairing-code-display">
                {pairing.code}
              </span>
              <div className="flex items-center gap-2 text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">
                {t("devices.access.expiresIn", { minutes: Math.floor(remaining / 60), seconds: String(remaining % 60).padStart(2, "0") })}
                <Button type="button" size="icon-xs" variant="ghost" aria-label={t("devices.access.cancel")} onClick={() => void cancel()}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <SettingsHint>{t("devices.access.addressHint")}</SettingsHint>
            {pairing.addresses.length === 0 ? (
              <SettingsHint className="text-[var(--app-status-warning)]">{t("devices.access.noAddress")}</SettingsHint>
            ) : pairing.addresses.map((address) => (
              <div key={address} className="flex items-center gap-2 text-[length:var(--text-small)]">
                <code className="text-[var(--app-text-primary)]">{address}</code>
                <Button type="button" size="icon-xs" variant="ghost" aria-label={t("devices.access.copy")} onClick={() => copy(address)}>
                  <Copy className="h-3 w-3 text-[var(--app-text-tertiary)]" />
                </Button>
              </div>
            ))}
          </div>
          <DevicePairingQr addresses={pairing.addresses} />
        </SettingsBlock>
      ) : null}

      {records.length === 0 ? (
        <SettingsBlock className="py-3">
          <SettingsHint>{t("devices.access.empty")}</SettingsHint>
        </SettingsBlock>
      ) : records.map((record) => (
        <DeviceAccessRow key={record.id} record={record} now={now} onRevoke={(item) => void revoke(item)} />
      ))}

      <WebSessionsList
        list={webSessions.list}
        error={webSessions.error}
        now={now}
        onChanged={() => void webSessions.reload()}
      />
      <RevokeOthersRow
        deviceCount={records.length}
        sessionCount={(webSessions.list?.sessions ?? []).filter((session) => !session.current).length}
        onDone={() => {
          void reload();
          void webSessions.reload();
        }}
      />
    </SettingsSection>
  );
}
