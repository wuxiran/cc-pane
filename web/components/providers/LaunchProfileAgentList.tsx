import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import CliBrandIcon from "@/components/CliBrandIcon";
import { CLI_COLOR_VAR } from "@/components/CliToolSelect";
import { useCliTools } from "@/hooks/useCliTools";
import { cn } from "@/lib/utils";
import { CLI_TOOL_TABS } from "@/types/provider";
import type { LaunchProfile } from "@/types";
import type { KnownCliTool } from "@/types/terminal";
import { profileMatchesTool } from "./launchProfileHelpers";

interface LaunchProfileAgentListProps {
  activeTool: KnownCliTool;
  profiles: readonly LaunchProfile[];
  onSelectTool: (tool: KnownCliTool) => void;
}

/**
 * 运行配置页左栏「智能体」视角：每个 CLI 一行（图标、版本、配置数），选中后右侧是它的配置。
 * 已安装的排前面；没装的收进「未安装」，当前选中的那个即使没装也留在上面，免得选中项消失。
 */
export default function LaunchProfileAgentList({ activeTool, profiles, onSelectTool }: LaunchProfileAgentListProps) {
  const { t } = useTranslation(["settings", "providers"]);
  const { getToolById } = useCliTools();
  const [showMissing, setShowMissing] = useState(false);

  const rows = CLI_TOOL_TABS.map((tab) => {
    const info = getToolById(tab.id);
    return {
      id: tab.id as KnownCliTool,
      name: t(tab.labelKey as never),
      installed: info?.installed ?? false,
      version: info?.version ?? null,
      profileCount: profiles.filter((profile) => profileMatchesTool(profile, tab.id)).length,
    };
  });
  const primary = rows.filter((row) => row.installed || row.id === activeTool || row.profileCount > 0);
  const missing = rows.filter((row) => !primary.includes(row));

  const renderRow = (row: (typeof rows)[number]) => {
    const active = row.id === activeTool;
    return (
      <button
        key={row.id}
        type="button"
        role="tab"
        aria-selected={active}
        data-cli-tool={row.id}
        data-current={active ? "true" : undefined}
        className={cn(
          // 不加 transition-colors：选中态要随点击立即落位，淡入会显得「跟手慢」。
          // 选中用强调色而非 hover 同色，否则选中行 + 悬停行看起来是两个选中项。
          "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left",
          active
            ? "bg-[color-mix(in_srgb,var(--app-accent)_12%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--app-accent)_45%,transparent)]"
            : "hover:bg-[var(--app-hover)]",
          !row.installed && "opacity-60",
        )}
        onClick={() => onSelectTool(row.id)}
      >
        <span className="shrink-0" style={{ color: CLI_COLOR_VAR[row.id] ?? "var(--app-accent)" }}>
          <CliBrandIcon cliTool={row.id} className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="truncate text-sm font-medium" style={{ color: "var(--app-text-primary)" }}>{row.name}</span>
            {row.version && (
              <span className="truncate font-mono text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>
                {row.version}
              </span>
            )}
          </span>
          <span className="block truncate text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
            {row.installed
              ? t("providers:agentProfileCount", { count: row.profileCount })
              : t("settings:cliNotInstalled")}
          </span>
        </span>
      </button>
    );
  };

  return (
    <div role="tablist" aria-label={t("settings:cliToolSelect")} className="space-y-0.5">
      {primary.map(renderRow)}
      {missing.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={showMissing}
            className="mt-1 flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-[var(--app-hover)]"
            style={{ color: "var(--app-text-tertiary)" }}
            onClick={() => setShowMissing((value) => !value)}
          >
            <ChevronRight size={13} className={cn("transition-transform", showMissing && "rotate-90")} />
            {t("providers:agentsNotInstalled", { count: missing.length })}
          </button>
          {showMissing && missing.map(renderRow)}
        </>
      )}
    </div>
  );
}
