// agent 启动跟随开关：leader 派 worker 时界面是否跳到目标布局。
// 默认关闭——每派一个 worker 就把用户从当前布局弹回去是最招人烦的行为；
// 关闭时 worker 仍建在目标布局，只是改发一条可跳转的提示（useOrchestratorListener）。
// 从 WebAccessSection 拆出（行数棘轮约束），与 McpYoloProfilesToggle 同构。
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import type { OrchestratorSettings } from "@/types";

export default function FollowAgentLaunchToggle({
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
        <Label>{t("followAgentLaunch")}</Label>
        <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
          {t("followAgentLaunchHint")}
        </p>
      </div>
      <input
        type="checkbox"
        aria-label={t("followAgentLaunch")}
        checked={orchestrator.followAgentLaunch}
        onChange={(event) => onChange({ ...orchestrator, followAgentLaunch: event.target.checked })}
        className="w-4 h-4 flex-none cursor-pointer"
        style={{ accentColor: "var(--app-accent)" }}
      />
    </div>
  );
}
