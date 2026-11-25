// 「已授权的客户端」里的一台已配对设备：在线状态 / 最后在线 / IP / 有效期，可单独移除。
import { useTranslation } from "react-i18next";
import { MonitorSmartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "@/components/settings/layout";
import type { DeviceAccessRecord } from "@/services/deviceService";
import { describeLastSeen } from "./deviceAccessFormat";

interface DeviceAccessRowProps {
  record: DeviceAccessRecord;
  now: number;
  onRevoke: (record: DeviceAccessRecord) => void;
}

function useActivityText(record: DeviceAccessRecord, now: number) {
  const { t } = useTranslation("settings");
  const seen = describeLastSeen(record.lastSeenAt, now);
  switch (seen.kind) {
    case "online":
      return { online: true, text: t("deviceAccess.activity.online") };
    case "never":
      return { online: false, text: t("deviceAccess.activity.never") };
    default:
      return { online: false, text: t(`deviceAccess.activity.${seen.kind}`, { count: seen.count }) };
  }
}

export default function DeviceAccessRow({ record, now, onRevoke }: DeviceAccessRowProps) {
  const { t } = useTranslation(["sidebar", "settings"]);
  const activity = useActivityText(record, now);
  const expiry = record.expired
    ? <span className="text-[var(--app-status-danger)]" data-testid="device-access-expired">{t("settings:deviceAccess.expiry.expired")}</span>
    : record.expiresAt
      ? t("settings:deviceAccess.expiry.until", { date: new Date(record.expiresAt).toLocaleDateString() })
      : t("settings:deviceAccess.expiry.neverShort");

  return (
    <SettingsRow
      icon={MonitorSmartphone}
      title={record.name}
      data-testid={`device-access-row-${record.id}`}
      description={(
        <>
          <span data-testid="device-access-activity" className="inline-flex items-center gap-1">
            {activity.online ? (
              <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--app-status-success)]" />
            ) : null}
            <span className={activity.online ? "text-[var(--app-status-success)]" : undefined}>{activity.text}</span>
          </span>
          {record.lastIp ? <>{" · "}{t("settings:deviceAccess.activity.ip", { ip: record.lastIp })}</> : null}
          {" · "}
          <code>{record.hint}…</code>
          {" · "}
          {t("devices.access.pairedAt", { date: new Date(record.createdAt).toLocaleDateString() })}
          {" · "}
          {expiry}
        </>
      )}
      control={(
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-[var(--app-status-danger)]"
          onClick={() => onRevoke(record)}
        >
          {t("devices.access.revoke")}
        </Button>
      )}
    />
  );
}
