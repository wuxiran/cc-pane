// MCP YOLO 授权开关：允许编排 agent 创建/绑定带 --dangerously-skip-permissions 的
// 启动配置（docs/63 R6）。默认关闭；从 WebAccessSection 拆出（行数棘轮约束）。
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import type { OrchestratorSettings } from "@/types";

export default function McpYoloProfilesToggle({
  orchestrator,
  onChange,
}: {
  orchestrator: OrchestratorSettings;
  onChange: (value: OrchestratorSettings) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="flex items-center justify-between gap-4 pt-2">
      <div>
        <Label>{t("allowMcpYoloProfiles")}</Label>
        <p className="text-xs m-0" style={{ color: "var(--app-status-danger)" }}>
          {t("allowMcpYoloProfilesHint")}
        </p>
      </div>
      <input
        type="checkbox"
        aria-label={t("allowMcpYoloProfiles")}
        checked={orchestrator.allowMcpYoloProfiles}
        onChange={(event) => onChange({ ...orchestrator, allowMcpYoloProfiles: event.target.checked })}
        className="w-4 h-4 flex-none cursor-pointer"
        style={{ accentColor: "var(--app-status-danger)" }}
      />
    </div>
  );
}
