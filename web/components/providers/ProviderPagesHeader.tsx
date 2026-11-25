import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  /** 页面级动作槽（凭证页放「从预设创建」/「从 cc-switch 导入」） */
  compact?: boolean;
  showTopViewTabs?: boolean;
  /** 运行配置页宽屏下智能体在左栏选，不再需要右上角这排 CLI 图标 */
  showToolSelect?: boolean;
  actions?: ReactNode;
  /** 凭证页不再有顶部标签：从运行配置进来后用它返回 */
  onBack?: () => void;
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
  compact,
  showTopViewTabs = true,
  showToolSelect = true,
  actions,
  onBack,
}: Props) {
  const { t } = useTranslation("settings");

  return (
    <div
      className={`flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 ${compact ? "py-2.5" : "px-6 py-3"}`}
    >
      {showTopViewTabs && (
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
      )}
      {onBack && (
        <Button variant="ghost" size={compact ? "xs" : "sm"} onClick={onBack}>
          <ArrowLeft size={14} /> {t("launchProfilesTab")}
        </Button>
      )}
      <div className="min-w-0 flex-1" />
      {showToolSelect && <ProviderToolSelect activeTab={activeTab} onTabChange={onTabChange} providerCounts={counts} />}
      {actions}
    </div>
  );
}
