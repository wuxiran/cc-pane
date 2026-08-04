import { useTranslation } from "react-i18next";
import { useCliTools } from "@/hooks/useCliTools";
import { PROVIDER_TYPE_META, type ProviderType } from "@/types/provider";
import type { KnownCliTool } from "@/types/terminal";
import { isProviderTypeCompatibleWithCli } from "@/utils/providerCompatibility";

interface ProviderTypeOptionsProps {
  activeTab?: KnownCliTool;
}

export default function ProviderTypeOptions({ activeTab }: ProviderTypeOptionsProps) {
  const { t } = useTranslation(["settings", "common"]);
  const { tools } = useCliTools();
  const providerTypes = (Object.keys(PROVIDER_TYPE_META) as ProviderType[])
    .filter((type) => !activeTab || isProviderTypeCompatibleWithCli(type, activeTab, tools));

  return providerTypes.map((type) => (
    <option key={type} value={type}>{t(PROVIDER_TYPE_META[type].labelKey)}</option>
  ));
}
