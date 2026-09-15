import { useTranslation } from "react-i18next";
import { CLI_TOOL_TABS } from "@/types/provider";
import type { KnownCliTool } from "@/types/terminal";
import { useCliTools } from "@/hooks/useCliTools";
import { CLI_COLOR_VAR } from "@/components/CliToolSelect";
import CliBrandIcon from "@/components/CliBrandIcon";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { cn } from "@/lib/utils";

interface Props {
  activeTab: KnownCliTool;
  onTabChange: (tab: KnownCliTool) => void;
  providerCounts: Record<string, number>;
}

function toolLabel(
  name: string,
  count: number,
  installed: boolean,
  notInstalled: string,
): string {
  const parts = [name];
  if (count > 0) parts.push(String(count));
  if (!installed) parts.push(notInstalled);
  return parts.join(" · ");
}

/**
 * 每个 CLI 一枚品牌图标，不再用下拉。计数和未安装状态写进 tooltip / aria-label。
 */
export default function ProviderToolTabs({ activeTab, onTabChange, providerCounts }: Props) {
  const { t } = useTranslation("settings");
  const { getToolById } = useCliTools();

  return (
    <div
      role="tablist"
      aria-label={t("cliToolSelect")}
      className="flex max-w-full shrink-0 flex-wrap items-center gap-0.5"
    >
      {CLI_TOOL_TABS.map((tab) => {
        const installed = getToolById(tab.id)?.installed ?? false;
        const count = providerCounts[tab.id] ?? 0;
        const active = activeTab === tab.id;
        const name = t(tab.labelKey as never);
        const label = toolLabel(name, count, installed, t("cliNotInstalled"));
        const color = CLI_COLOR_VAR[tab.id] ?? "var(--app-accent)";

        return (
          <IconTooltipButton
            key={tab.id}
            label={label}
            role="tab"
            aria-selected={active}
            data-cli-tool={tab.id}
            className={cn(
              "relative size-8 rounded-md",
              active
                ? "bg-[var(--app-panel-bg)] shadow-[inset_0_0_0_1px_var(--app-border)]"
                : "text-[var(--app-text-secondary)]",
              !installed && "opacity-45",
            )}
            style={{ color }}
            onClick={() => onTabChange(tab.id)}
          >
            <CliBrandIcon cliTool={tab.id} className="size-4" />
            {count > 0 && (
              <span
                aria-hidden="true"
                className="absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-[var(--app-hover)] px-0.5 text-center text-[9px] leading-3.5 tabular-nums text-[var(--app-text-tertiary)]"
              >
                {count}
              </span>
            )}
          </IconTooltipButton>
        );
      })}
    </div>
  );
}
