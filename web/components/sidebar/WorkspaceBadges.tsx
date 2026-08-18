import { useTranslation } from "react-i18next";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { sidebarEntityBadgeClass } from "./sidebarStyles";

const ACCENT_BADGE = `${sidebarEntityBadgeClass} font-semibold tracking-wide bg-[color-mix(in_srgb,var(--app-accent)_16%,transparent)] text-[var(--app-accent)]`;
const MUTED_BADGE = `${sidebarEntityBadgeClass} bg-[color-mix(in_srgb,var(--app-text-primary)_8%,transparent)] text-[var(--app-text-secondary)]`;
const FADED_BADGE = `${sidebarEntityBadgeClass} bg-[color-mix(in_srgb,var(--app-text-primary)_8%,transparent)] text-[var(--app-text-tertiary)]`;

interface WorkspaceBadgesProps {
  isDefault: boolean;
  showWsl: boolean;
  isArchived: boolean;
  providerName?: string;
}

/** 工作空间行尾的状态徽章簇。 */
export default function WorkspaceBadges({
  isDefault,
  showWsl,
  isArchived,
  providerName,
}: WorkspaceBadgesProps) {
  const { t } = useTranslation("sidebar");

  return (
    <>
      {/* defaultBadge 在 zh-CN/en 两份 locale 里都有，不再带裸中文 defaultValue 兜底 */}
      {isDefault ? <span className={ACCENT_BADGE}>{t("defaultBadge")}</span> : null}
      {showWsl ? <span className={ACCENT_BADGE}>WSL</span> : null}
      {/* 已归档条目只在打开「含已归档」时可见，必须一眼能与正常条目区分 */}
      {isArchived ? (
        <span className={FADED_BADGE}>{t("archivedBadge")}</span>
      ) : null}
      {providerName ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={MUTED_BADGE}>{providerName}</span>
          </TooltipTrigger>
          <TooltipContent side="top">Provider: {providerName}</TooltipContent>
        </Tooltip>
      ) : null}
    </>
  );
}
