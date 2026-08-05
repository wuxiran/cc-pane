import { useTranslation } from "react-i18next";
import { CLI_TOOL_TABS } from "@/types/provider";
import type { KnownCliTool } from "@/types/terminal";
import { useCliTools } from "@/hooks/useCliTools";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface Props {
  activeTab: KnownCliTool;
  onTabChange: (tab: KnownCliTool) => void;
  providerCounts: Record<string, number>;
}

/** CLI 身份色 token（亮暗两套定义在 index.css，docs/46 §0 铁律1：不拼 hex） */
const CLI_COLOR_VAR: Record<string, string> = {
  claude: "var(--app-cli-claude)",
  codex: "var(--app-cli-codex)",
  gemini: "var(--app-cli-gemini)",
  kimi: "var(--app-cli-kimi)",
  glm: "var(--app-cli-glm)",
  opencode: "var(--app-cli-opencode)",
  cursor: "var(--app-cli-cursor)",
  grok: "var(--app-cli-grok)",
};

export default function ProviderToolTabs({ activeTab, onTabChange, providerCounts }: Props) {
  const { t } = useTranslation("settings");
  const { getToolById } = useCliTools();

  return (
    <div className="flex gap-1.5 overflow-x-auto">
      {CLI_TOOL_TABS.map((tab) => {
        const isActive = activeTab === tab.id;
        const count = providerCounts[tab.id] ?? 0;
        const tool = getToolById(tab.id);
        const installed = tool?.installed ?? false;
        const cliColor = CLI_COLOR_VAR[tab.id] ?? "var(--app-accent)";

        return (
          <button
            key={tab.id}
            type="button"
            data-state={isActive ? "active" : "inactive"}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors duration-[var(--dur-fast)] data-[state=inactive]:border-[var(--app-border)] data-[state=inactive]:text-[var(--app-text-secondary)] data-[state=inactive]:hover:bg-[var(--app-hover)]"
            style={
              isActive
                ? {
                    color: cliColor,
                    background: `color-mix(in srgb, ${cliColor} 10%, transparent)`,
                    borderColor: `color-mix(in srgb, ${cliColor} 45%, var(--app-border))`,
                  }
                : undefined
            }
            onClick={() => onTabChange(tab.id)}
          >
            <span>{t(tab.labelKey as never)}</span>
            {count > 0 && (
              <span
                className="inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold"
                style={
                  isActive
                    ? {
                        background: `color-mix(in srgb, ${cliColor} 16%, transparent)`,
                        color: cliColor,
                      }
                    : { background: "var(--app-hover)", color: "var(--app-text-tertiary)" }
                }
              >
                {count}
              </span>
            )}
            {!installed && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span aria-label={t("cliNotInstalled")} className="text-[10px] opacity-60">
                    ●
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {t("cliNotInstalled")}
                </TooltipContent>
              </Tooltip>
            )}
          </button>
        );
      })}
    </div>
  );
}
