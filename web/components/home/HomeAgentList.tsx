// 首页「Agent」卡：本机已安装的 CLI 一行一个，可直接切默认供应商、一键启动。
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Download, RefreshCw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { Skeleton } from "@/components/ui/skeleton";
import { useDialogStore, useProvidersStore } from "@/stores";
import { SYSTEM_PROVIDER_ID } from "@/types/provider";
import type { CliToolInfo, KnownCliTool, OpenTerminalOptions } from "@/types";
import { isProviderTypeCompatibleWithCli } from "@/utils/providerCompatibility";
import { toastErr } from "@/lib/feedback";
import { useCliUpdates } from "@/hooks/useCliUpdates";
import HomeAgentRow from "./HomeAgentRow";
import { currentInstallPlatform } from "./agentCatalog";
import { batchUpdateCommands, pendingUpdates } from "./agentUpdates";
import { useRunAgentCommand } from "./useRunAgentCommand";

interface HomeAgentListProps {
  tools: readonly CliToolInfo[];
  installedTools: readonly CliToolInfo[];
  loading: boolean;
  onRefresh: () => void;
  /** 升级命令在应用内新终端里跑；不传则不显示更新入口。 */
  onOpenTerminal?: (opts: OpenTerminalOptions) => void;
}

const NOOP_OPEN = () => undefined;

export default function HomeAgentList({ tools, installedTools, loading, onRefresh, onOpenTerminal }: HomeAgentListProps) {
  const { t } = useTranslation("home");
  const providers = useProvidersStore((s) => s.providers);
  const defaultProviderIds = useProvidersStore((s) => s.defaultProviderIds);
  const systemActive = useProvidersStore((s) => s.systemActive);
  const loadProviders = useProvidersStore((s) => s.loadProviders);
  const setDefault = useProvidersStore((s) => s.setDefault);

  useEffect(() => {
    void loadProviders().catch(() => undefined);
  }, [loadProviders]);

  const toolList = useMemo(() => [...tools], [tools]);

  const { infos: updateInfos, recheck: recheckUpdates } = useCliUpdates(Boolean(onOpenTerminal) && installedTools.length > 0);
  const updates = useMemo(() => pendingUpdates(installedTools, updateInfos), [installedTools, updateInfos]);
  const updateById = useMemo(() => new Map(updates.map((update) => [update.id, update])), [updates]);
  const runCommand = useRunAgentCommand(onOpenTerminal ?? NOOP_OPEN);
  const updateAll = () => {
    for (const command of batchUpdateCommands(updates, currentInstallPlatform())) void runCommand(command);
  };
  const refreshAll = () => {
    onRefresh();
    if (onOpenTerminal) recheckUpdates();
  };

  // 与 useProvidersStore.defaultProvider 同口径：显式默认 → 检测到 cc-switch 走系统 → 第一个供应商。
  const effectiveFor = (cliTool: string) => {
    const explicit = defaultProviderIds[cliTool as KnownCliTool];
    if (explicit === SYSTEM_PROVIDER_ID) return { id: SYSTEM_PROVIDER_ID, name: null };
    const match = providers.find((provider) => provider.id === explicit);
    if (match) return { id: match.id, name: match.name };
    if (systemActive || providers.length === 0) return { id: SYSTEM_PROVIDER_ID, name: null };
    return { id: providers[0].id, name: providers[0].name };
  };

  const handleChange = (cliTool: string, providerId: string) => {
    setDefault(providerId, cliTool as KnownCliTool).catch(() => toastErr(t("agents.setDefaultFailed")));
  };

  return (
    <section data-testid="home-agent-list" aria-label={t("agents.title")}>
      {onOpenTerminal && updates.length > 0 && (
        <div data-testid="home-agent-updates" className="mb-3 flex items-center gap-3 px-1">
          <span className="min-w-0 flex-1 truncate text-[length:var(--text-body)] text-[var(--app-text-secondary)]">
            {t("agents.updatesAvailable", { count: updates.length, names: updates.map((update) => update.name).join(", ") })}
          </span>
          <Button type="button" variant="outline" size="sm" className="shrink-0 gap-1.5 rounded-full" onClick={updateAll}>
            <Download className="size-3.5" aria-hidden="true" />
            {t("agents.updateAll")}
          </Button>
        </div>
      )}
      <div className="mb-3 flex items-center gap-2 px-1">
        <h2 className="text-[length:var(--text-title)] font-semibold text-[var(--app-text-primary)]">{t("agents.title")}</h2>
        {!loading && installedTools.length > 0 && (
          <span className="text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">
            {t("agents.count", { count: installedTools.length })}
          </span>
        )}
        <IconTooltipButton label={t("agents.refresh")} className="ml-auto" disabled={loading} onClick={refreshAll}>
          <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} aria-hidden="true" />
        </IconTooltipButton>
      </div>
      <div className="overflow-hidden rounded-2xl border border-[var(--app-home-border)] bg-[var(--app-home-surface)]">
        {loading && installedTools.length === 0 ? (
          <div aria-label={t("agents.detecting")} className="divide-y divide-[var(--app-home-row-border)]">
            {[0, 1, 2].map((key) => (
              <div key={key} className="flex items-center gap-4 px-5 py-4">
                <Skeleton className="size-10 rounded-xl" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-3 w-48" />
                </div>
                <Skeleton className="h-9 w-56" />
              </div>
            ))}
          </div>
        ) : installedTools.length === 0 ? (
          <p className="px-5 py-8 text-center text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">{t("agents.empty")}</p>
        ) : (
          <ul className="divide-y divide-[var(--app-home-row-border)]">
            {installedTools.map((tool) => {
              const effective = effectiveFor(tool.id);
              // 生效中的默认即使不兼容也要列出来，否则下拉框会显示空白。
              const compatible = providers.filter((provider) =>
                provider.id === effective.id
                || isProviderTypeCompatibleWithCli(provider.providerType, tool.id, toolList),
              );
              return (
                <HomeAgentRow
                  key={tool.id}
                  tool={tool}
                  providers={compatible}
                  effectiveProviderId={effective.id}
                  effectiveProviderName={effective.name}
                  onChangeProvider={(providerId) => handleChange(tool.id, providerId)}
                  onLaunch={() => useDialogStore.getState().openLauncher({ cliTool: tool.id })}
                  update={updateById.get(tool.id)}
                  onUpdate={() => {
                    const update = updateById.get(tool.id);
                    if (update) void runCommand(update.command);
                  }}
                />
              );
            })}
          </ul>
        )}
        <div className="flex justify-end border-t border-[var(--app-home-row-border)] px-3 py-2">
          <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={() => useDialogStore.getState().openSettings()}>
            <Settings2 className="size-3.5" aria-hidden="true" />
            {t("agents.manage")}
          </Button>
        </div>
      </div>
    </section>
  );
}
