import { useTranslation } from "react-i18next";
import { CLI_TOOL_TABS } from "@/types/provider";
import type { KnownCliTool } from "@/types/terminal";
import { useCliTools } from "@/hooks/useCliTools";

interface Props {
  activeTab: KnownCliTool;
  onTabChange: (tab: KnownCliTool) => void;
  providerCounts: Record<string, number>;
  compact?: boolean;
}

export default function ProviderToolTabs({ activeTab, onTabChange, providerCounts, compact }: Props) {
  const { t } = useTranslation("settings");
  const { getToolById } = useCliTools();

  return (
    <div className={`flex ${compact ? "gap-1" : "gap-2"}`}>
      {CLI_TOOL_TABS.map((tab) => {
        const isActive = activeTab === tab.id;
        const count = providerCounts[tab.id] ?? 0;
        const tool = getToolById(tab.id);
        const installed = tool?.installed ?? false;

        return (
          <button
            key={tab.id}
            type="button"
            className={`
              inline-flex items-center rounded-lg transition-all font-semibold
              ${compact ? "gap-1.5 px-2.5 py-1.5 text-xs" : "h-10 gap-2 px-4 text-sm"}
              ${isActive
                ? "shadow-sm"
                : "hover:bg-[var(--app-hover)]"
              }
            `}
            style={{
              background: isActive ? `${tab.accentColor}22` : "var(--app-content)",
              color: isActive ? tab.accentColor : "var(--app-text-secondary)",
              border: isActive ? `1px solid ${tab.accentColor}66` : "1px solid var(--app-border)",
              boxShadow: isActive ? `0 0 0 1px ${tab.accentColor}22 inset` : undefined,
            }}
            onClick={() => onTabChange(tab.id)}
          >
            <span>{t(tab.labelKey as never)}</span>
            {count > 0 && (
              <span
                className="inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full text-[10px] font-semibold px-1"
                style={{
                  background: isActive ? `${tab.accentColor}25` : "var(--app-hover)",
                  color: isActive ? tab.accentColor : "var(--app-text-tertiary)",
                }}
              >
                {count}
              </span>
            )}
            {!installed && (
              <span
                className="text-[10px] opacity-60"
                title={t("cliNotInstalled")}
              >
                ●
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
