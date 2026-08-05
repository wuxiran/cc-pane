import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCliTools } from "@/hooks/useCliTools";
import { PROVIDER_TYPE_META, type ProviderType } from "@/types/provider";
import type { KnownCliTool } from "@/types/terminal";
import { isProviderTypeCompatibleWithCli } from "@/utils/providerCompatibility";

interface ProviderTypeSelectProps {
  value: ProviderType;
  onChange: (type: ProviderType) => void;
  /** 传入时只列出与该 CLI 兼容的 Provider 类型 */
  activeTab?: KnownCliTool;
}

/** Provider 类型选择器（docs/46 §1：原生 select 已全部迁到 Radix Select） */
export default function ProviderTypeSelect({ value, onChange, activeTab }: ProviderTypeSelectProps) {
  const { t } = useTranslation(["settings", "common"]);
  const { tools } = useCliTools();
  const providerTypes = (Object.keys(PROVIDER_TYPE_META) as ProviderType[])
    .filter((type) => !activeTab || isProviderTypeCompatibleWithCli(type, activeTab, tools));

  return (
    <Select value={value} onValueChange={(next) => onChange(next as ProviderType)}>
      <SelectTrigger aria-label={t("providerType")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {providerTypes.map((type) => (
          <SelectItem key={type} value={type}>{t(PROVIDER_TYPE_META[type].labelKey)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
