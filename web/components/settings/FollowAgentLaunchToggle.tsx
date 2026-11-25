// agent 启动跟随开关：leader 派 worker 时界面是否跳到目标布局。
// 默认关闭——每派一个 worker 就把用户从当前布局弹回去是最招人烦的行为；
// 关闭时 worker 仍建在目标布局，只是改发一条可跳转的提示（useOrchestratorListener）。
// 从 WebAccessSection 拆出（行数棘轮约束），与 McpYoloProfilesToggle 同构。
import { useTranslation } from "react-i18next";
import type { OrchestratorSettings } from "@/types";
import { SettingsSwitchRow } from "./layout";

export default function FollowAgentLaunchToggle({
  orchestrator,
  onChange,
}: {
  orchestrator: OrchestratorSettings;
  onChange: (value: OrchestratorSettings) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <SettingsSwitchRow
      id="web-access-follow-agent-launch"
      title={t("followAgentLaunch")}
      description={t("followAgentLaunchHint")}
      checked={orchestrator.followAgentLaunch}
      onCheckedChange={(checked) => onChange({ ...orchestrator, followAgentLaunch: checked })}
    />
  );
}
