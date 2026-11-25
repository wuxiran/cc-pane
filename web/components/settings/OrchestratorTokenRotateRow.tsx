// 设置 → 设备与访问 → 编排器（MCP 端点）：更换访问令牌。
// 确认框如实说明影响：旧令牌立即失效；正在运行的会话启动时拿到的是旧令牌，无法热更新。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { toastErr, toastOk } from "@/lib/feedback";
import { Button } from "@/components/ui/button";
import { getOrchestratorRotationImpact, rotateOrchestratorToken } from "@/services/accessService";
import { nativeConfirm } from "@/services/nativeDialog";
import { SettingsRow } from "./layout";

export default function OrchestratorTokenRotateRow() {
  const { t } = useTranslation("settings");
  const [busy, setBusy] = useState(false);

  const rotate = async () => {
    setBusy(true);
    try {
      const impact = await getOrchestratorRotationImpact().catch(() => null);
      const message = impact
        ? t("webAccessSection.orchestrator.rotate.confirm", { count: impact.runningSessions })
        : t("webAccessSection.orchestrator.rotate.confirmUnknown");
      if (!(await nativeConfirm(message))) return;
      await rotateOrchestratorToken();
      toastOk(t("webAccessSection.orchestrator.rotate.done"));
    } catch (error) {
      toastErr(t("webAccessSection.orchestrator.rotate.failed", { error: String(error) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsRow
      icon={KeyRound}
      title={t("webAccessSection.orchestrator.rotate.title")}
      description={t("webAccessSection.orchestrator.rotate.description")}
      control={(
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void rotate()}
          data-testid="orchestrator-rotate-token"
        >
          {t("webAccessSection.orchestrator.rotate.button")}
        </Button>
      )}
    />
  );
}
