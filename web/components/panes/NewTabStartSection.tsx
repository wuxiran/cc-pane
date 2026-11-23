import { useMemo } from "react";
import { MessagesSquare, MoreHorizontal, Terminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import CliBrandIcon from "@/components/CliBrandIcon";
import { useCliTools } from "@/hooks/useCliTools";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { getAvailableSidebarCliToolIds, SIDEBAR_LAUNCH_CLI_TOOLS, type SidebarLaunchCliTool } from "@/components/sidebar/launchMenu";

const pillClass = "inline-flex h-9 min-w-0 max-w-full items-center gap-2 rounded-full border border-[var(--app-border)] "
  + "bg-[var(--app-panel-bg-effective)] px-3.5 text-sm text-[var(--app-text-primary)] transition-colors duration-[var(--dur-fast)] "
  + "hover:bg-[var(--app-hover)] "
  + "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]";

/** 只列已探测到（或配置了自定义启动命令）的 CLI；探测未完成前不列，避免点到不存在的命令。 */
export function useInstalledNewTabCliTools(): SidebarLaunchCliTool[] {
  const { tools, loading } = useCliTools();
  const overrides = useSettingsStore((s) => s.settings?.cliLaunchers.overrides);
  return useMemo(() => {
    const available = getAvailableSidebarCliToolIds(loading && tools.length === 0 ? undefined : tools, overrides);
    if (!available) return [];
    return SIDEBAR_LAUNCH_CLI_TOOLS.filter((tool) => available.has(tool.id)).map((tool) => tool.id);
  }, [loading, overrides, tools]);
}

function Pill({ label, onClick, icon: Icon, cliTool }: { label: string; onClick: () => void; icon?: LucideIcon; cliTool?: string }) {
  return <button type="button" aria-label={label} title={label} onClick={onClick} className={pillClass}>
    {cliTool ? <CliBrandIcon cliTool={cliTool} className="size-4 shrink-0 text-[var(--app-text-secondary)]" />
      : Icon && <Icon className="size-4 shrink-0 text-[var(--app-text-secondary)]" aria-hidden="true" />}
    <span className="truncate">{label}</span>
  </button>;
}

export default function NewTabStartSection({ onLaunchCli, onTerminal, onAgentChat, onMore }: {
  onLaunchCli: (cliTool: SidebarLaunchCliTool) => void;
  onTerminal: () => void;
  onAgentChat: () => void;
  onMore: () => void;
}) {
  const { t } = useTranslation(["panes", "sidebar"]);
  const cliTools = useInstalledNewTabCliTools();
  const labelOf = (id: SidebarLaunchCliTool) =>
    t(SIDEBAR_LAUNCH_CLI_TOOLS.find((tool) => tool.id === id)!.labelKey as never, { ns: "sidebar" });

  return <section aria-labelledby="new-tab-start-heading">
    <h2 id="new-tab-start-heading" className="mb-3 text-xs font-medium text-[var(--app-text-tertiary)]">{t("newTabPage.start")}</h2>
    <div className="flex flex-wrap gap-2">
      {cliTools.map((id) => <Pill key={id} cliTool={id} label={labelOf(id)} onClick={() => onLaunchCli(id)} />)}
      <Pill icon={Terminal} label={t("newTabPage.terminal")} onClick={onTerminal} />
      <Pill icon={MessagesSquare} label={t("newTabPage.agent")} onClick={onAgentChat} />
      <button type="button" onClick={onMore} aria-label={t("newTabPage.moreLaunch")} title={t("newTabPage.moreLaunchHint")}
        className={`${pillClass} border-dashed bg-transparent text-[var(--app-text-secondary)]`}>
        <MoreHorizontal className="size-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{t("newTabPage.more")}</span>
      </button>
    </div>
  </section>;
}
