// MCP YOLO 授权开关：允许编排 agent 创建/绑定带 --dangerously-skip-permissions 的
// 启动配置（docs/63 R6）。默认关闭；从 WebAccessSection 拆出（行数棘轮约束）。
import { useTranslation } from "react-i18next";
import type { OrchestratorSettings } from "@/types";
import { SettingsSwitchRow } from "./layout";

export default function McpYoloProfilesToggle({
  orchestrator,
  onChange,
}: {
  orchestrator: OrchestratorSettings;
  onChange: (value: OrchestratorSettings) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <SettingsSwitchRow
      id="web-access-allow-mcp-yolo-profiles"
      title={t("allowMcpYoloProfiles")}
      description={<span style={{ color: "var(--app-status-danger)" }}>{t("allowMcpYoloProfilesHint")}</span>}
      checked={orchestrator.allowMcpYoloProfiles}
      onCheckedChange={(checked) => onChange({ ...orchestrator, allowMcpYoloProfiles: checked })}
    />
  );
}
