// 介绍文案「中 / EN」切换：技能页、MCP 页共用，偏好落在 useDescriptionLangStore。
import { useTranslation } from "react-i18next";
import { useDescriptionLang } from "@/hooks/useDescriptionLang";
import type { DescriptionLocale } from "@/utils/localizedText";
import { SegmentedTabs } from "./segmented";

const ITEMS: ReadonlyArray<{ value: DescriptionLocale; label: string }> = [
  { value: "zh-CN", label: "中" },
  { value: "en", label: "EN" },
];

export function DescriptionLangToggle({ className }: { className?: string }) {
  const { t } = useTranslation("common");
  const { locale, setLocale } = useDescriptionLang();
  return (
    <SegmentedTabs
      size="sm"
      value={locale}
      onValueChange={setLocale}
      items={ITEMS}
      className={className}
      aria-label={t("descriptionLang")}
    />
  );
}
