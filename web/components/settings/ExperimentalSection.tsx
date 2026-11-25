// 设置 → 实验性功能：每个开关对应 ExperimentalSettings 的一个字段。默认全关，
// 用户勾选后相关入口（活动栏图标 / 全屏页 / 面板区块）才渲染。
import { FlaskConical } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ExperimentalFeatureId, ExperimentalSettings } from "@/types";
import PerformanceDiagnosticsCard from "./PerformanceDiagnosticsCard";
import { SettingsBlock, SettingsSection, SettingsSwitchRow } from "./layout";

interface ExperimentalSectionProps {
  value: ExperimentalSettings;
  onChange: (value: ExperimentalSettings) => void;
}

const FEATURES: {
  id: ExperimentalFeatureId;
  labelKey: "experimental.dramaStudio" | "experimental.librarySpace";
  descKey: "experimental.dramaStudioDesc" | "experimental.librarySpaceDesc";
}[] = [
  { id: "dramaStudio", labelKey: "experimental.dramaStudio", descKey: "experimental.dramaStudioDesc" },
  { id: "librarySpace", labelKey: "experimental.librarySpace", descKey: "experimental.librarySpaceDesc" },
];

export default function ExperimentalSection({ value, onChange }: ExperimentalSectionProps) {
  const { t } = useTranslation("settings");

  return (
    <>
      <SettingsSection>
        {/* 风险提示：琥珀色图标 + 正文同时表达（状态不只靠颜色），作为卡片首行而非单独的警示卡 */}
        <SettingsBlock className="flex items-start gap-2 py-3">
          <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--app-status-warning)]" />
          <p className="m-0 text-[length:var(--text-small)] leading-5 text-[var(--app-text-secondary)]">
            {t("experimental.notice")}
          </p>
        </SettingsBlock>
        {FEATURES.map(({ id, labelKey, descKey }) => (
          <SettingsSwitchRow
            key={id}
            id={`experimental-${id}`}
            title={t(labelKey)}
            description={t(descKey)}
            checked={value[id]}
            onCheckedChange={(checked) => onChange({ ...value, [id]: checked === true })}
          />
        ))}
      </SettingsSection>
      <PerformanceDiagnosticsCard />
    </>
  );
}
