import { useTranslation } from "react-i18next";
import { CLI_TOOL_TABS } from "@/types/provider";
import type { KnownCliTool } from "@/types/terminal";
import { useCliTools } from "@/hooks/useCliTools";
import CliToolSelect from "@/components/CliToolSelect";

interface Props {
  activeTab: KnownCliTool;
  onTabChange: (tab: KnownCliTool) => void;
  providerCounts: Record<string, number>;
}

/**
 * CLI 数量已经超过横向标签适合承载的范围；统一用下拉选择，计数和安装状态放在选项内。
 */
export default function ProviderToolTabs({ activeTab, onTabChange, providerCounts }: Props) {
  const { t } = useTranslation("settings");
  const { getToolById } = useCliTools();

  return (
    <CliToolSelect
      value={activeTab}
      onValueChange={(value) => onTabChange(value as KnownCliTool)}
      className="w-[172px]"
      options={CLI_TOOL_TABS.map((tab) => ({
        id: tab.id,
        label: t(tab.labelKey as never),
        installed: getToolById(tab.id)?.installed ?? false,
        count: providerCounts[tab.id] ?? 0,
      }))}
    />
  );
}
