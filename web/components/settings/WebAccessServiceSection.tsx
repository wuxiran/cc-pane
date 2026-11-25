// 设置 → 设备与访问 → 服务控制：Web 服务状态 + 打开 / 启动 / 重启 / 停止（从 WebAccessSection 拆出）。
import { useTranslation } from "react-i18next";
import { ExternalLink, RefreshCw, Square, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isTauriRuntime } from "@/services/runtime";
import type { WebAccessStatus } from "@/types";
import { SettingsBlock, SettingsRow, SettingsSection } from "./layout";

export type WebAccessServiceAction = "start" | "stop" | "restart" | "open";

interface WebAccessServiceSectionProps {
  status: WebAccessStatus | null;
  loadingStatus: boolean;
  onRefresh: () => void;
  onAction: (action: WebAccessServiceAction) => Promise<void>;
}

export default function WebAccessServiceSection({ status, loadingStatus, onRefresh, onAction }: WebAccessServiceSectionProps) {
  const { t } = useTranslation("settings");
  return (
    <SettingsSection sectionId="web-access-service" title={t("webAccessGroups.service")}>
      <SettingsRow
        title={status
          ? `${t(status.running ? "webAccessSection.status.running" : "webAccessSection.status.stopped")} · ${status.url} · ${status.bindHost}:${status.port}`
          : t("webAccessSection.status.unread")}
        description={t("webAccessSection.restartHint")}
        control={(
          <Button type="button" variant="ghost" size="sm" onClick={onRefresh} disabled={loadingStatus}
            aria-label={t("webAccessGroups.refreshStatus")} title={t("webAccessGroups.refreshStatus")}>
            <RefreshCw className={`w-3.5 h-3.5 ${loadingStatus ? "animate-spin" : ""}`} />
          </Button>
        )}
      />
      <SettingsBlock className="flex flex-wrap gap-2 py-3">
        <Button type="button" variant="secondary" size="sm" onClick={() => void onAction("open")}>
          <ExternalLink className="w-3.5 h-3.5 mr-1" />
          {t("webAccessSection.openWeb")}
        </Button>
        {isTauriRuntime() && (
          <>
            <Button type="button" variant="secondary" size="sm" onClick={() => void onAction("start")}>
              <Wifi className="w-3.5 h-3.5 mr-1" />
              {t("webAccessSection.start")}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => void onAction("restart")}>
              <RefreshCw className="w-3.5 h-3.5 mr-1" />
              {t("webAccessSection.restart")}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => void onAction("stop")}>
              <Square className="w-3.5 h-3.5 mr-1" />
              {t("webAccessSection.stop")}
            </Button>
          </>
        )}
      </SettingsBlock>
    </SettingsSection>
  );
}
