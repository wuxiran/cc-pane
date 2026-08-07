import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedTabs } from "@/components/ui/segmented";
import ProviderToolSelect from "./ProviderToolTabs";
import type { KnownCliTool } from "@/types/terminal";

export type ProviderTopView = "profiles" | "providers";

interface Props {
  topView: ProviderTopView;
  onTopViewChange: (view: ProviderTopView) => void;
  activeTab: KnownCliTool;
  onTabChange: (tab: KnownCliTool) => void;
  /** 当前子页语义下的 chips 计数（凭证页=provider 数，运行配置页=profile 数） */
  counts: Record<string, number>;
  /** 页面级动作槽（凭证页放「从预设创建」） */
  actions?: ReactNode;
  compact?: boolean;
}

/**
 * Provider 设置页统一 header：子页切换留在左侧，CLI 和页面动作收在右侧。
 */
export default function ProviderPagesHeader({
  topView,
  onTopViewChange,
  activeTab,
  onTabChange,
  counts,
  actions,
  compact,
}: Props) {
  const { t } = useTranslation("settings");

  return (
    <div
      className={`flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--app-border)] ${compact ? "px-4 py-2.5" : "px-6 py-3"}`}
    >
      <SegmentedTabs
        aria-label={t("provider")}
        value={topView}
        onValueChange={onTopViewChange}
        size={compact ? "sm" : "md"}
        items={[
          { value: "profiles", label: t("launchProfilesTab") },
          { value: "providers", label: t("providerCredentialsTab") },
        ]}
      />
      <div className="min-w-0 flex-1" />
      <ProviderToolSelect activeTab={activeTab} onTabChange={onTabChange} providerCounts={counts} />
      {actions}
    </div>
  );
}
