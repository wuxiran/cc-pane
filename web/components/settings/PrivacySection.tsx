// 设置 → 隐私与安全：每个开关对应 PrivacySettings 的一个字段。全部默认关闭（Dev 也一样），
// 打开后相关入口才出现；只作用于 API key 供应商，不碰订阅登录账号。
// 版式走 ./layout 原语（page → section → row），搜索锚点 privacy-root 由 SettingsPaneContent 外层提供。
import { Shield } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PrivacySettings } from "@/types";
import { SettingsBlock, SettingsSection, SettingsSwitchRow } from "./layout";

interface PrivacySectionProps {
  value: PrivacySettings;
  onChange: (value: PrivacySettings) => void;
}

const FEATURES: {
  id: keyof PrivacySettings;
  labelKey: "privacy.channelPurity";
  descKey: "privacy.channelPurityDesc";
}[] = [
  { id: "channelPurity", labelKey: "privacy.channelPurity", descKey: "privacy.channelPurityDesc" },
];

export default function PrivacySection({ value, onChange }: PrivacySectionProps) {
  const { t } = useTranslation("settings");

  return (
    <SettingsSection>
      {/* 说明作为卡片首行：这些功能会真实调用模型，默认关闭，打开后入口才出现 */}
      <SettingsBlock className="flex items-start gap-2 py-3">
        <Shield aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--app-accent)]" />
        <p className="m-0 text-[length:var(--text-small)] leading-5 text-[var(--app-text-secondary)]">
          {t("privacy.notice")}
        </p>
      </SettingsBlock>
      {FEATURES.map(({ id, labelKey, descKey }) => (
        <SettingsSwitchRow
          key={id}
          id={`privacy-${id}`}
          title={t(labelKey)}
          description={t(descKey)}
          checked={value[id] === true}
          onCheckedChange={(checked) => onChange({ ...value, [id]: checked === true })}
        />
      ))}
    </SettingsSection>
  );
}
