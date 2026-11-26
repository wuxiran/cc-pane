// Agent 列表的一行（参考 magpie）：品牌图标 + 名称/版本 + 状态说明 + 默认供应商下拉 + 启动。
import { useTranslation } from "react-i18next";
import { Download, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import CliBrandIcon from "@/components/CliBrandIcon";
import PurityBadge from "@/components/providers/PurityBadge";
import { SYSTEM_PROVIDER_ID, type Provider } from "@/types/provider";
import type { CliToolInfo } from "@/types";
import { cn } from "@/lib/utils";
import type { AgentUpdate } from "./agentUpdates";

interface HomeAgentRowProps {
  tool: CliToolInfo;
  /** 与该 CLI 兼容的供应商（不含「系统环境变量」合成项）。 */
  providers: readonly Provider[];
  /** 当前生效的默认供应商 id；SYSTEM_PROVIDER_ID 表示不注入、跟随 CLI 自身设置。 */
  effectiveProviderId: string;
  effectiveProviderName: string | null;
  onChangeProvider: (providerId: string) => void;
  onLaunch: () => void;
  /** 有新版本时传入；点按钮在新终端里跑升级命令。 */
  update?: AgentUpdate;
  onUpdate?: () => void;
}

export default function HomeAgentRow({
  tool,
  providers,
  effectiveProviderId,
  effectiveProviderName,
  onChangeProvider,
  onLaunch,
  update,
  onUpdate,
}: HomeAgentRowProps) {
  const { t } = useTranslation("home");
  const usingOwn = effectiveProviderId === SYSTEM_PROVIDER_ID || !effectiveProviderName;
  const effectiveProvider = usingOwn ? undefined : providers.find((provider) => provider.id === effectiveProviderId);
  const status = usingOwn
    ? t("agents.usingOwn", { name: tool.displayName })
    : t("agents.usingProvider", { name: effectiveProviderName });

  return (
    <li data-testid="home-agent-row" data-cli-id={tool.id} className="flex items-center gap-4 px-5 py-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--app-hover)] text-[var(--app-text-primary)]">
        <CliBrandIcon cliTool={tool.id} className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[length:var(--text-body)] font-medium text-[var(--app-text-primary)]">{tool.displayName}</span>
          {tool.version && (
            <span className="shrink-0 font-mono text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">{tool.version}</span>
          )}
          {update && onUpdate && (
            <button
              type="button"
              data-testid="home-agent-update"
              title={t("agents.updateTitle", { command: update.command })}
              onClick={onUpdate}
              className="inline-flex shrink-0 items-center gap-1 self-center rounded-full border border-[var(--app-border)] px-2 py-0.5 text-[length:var(--text-small)] text-[var(--app-text-primary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)]"
            >
              <Download className="size-3" aria-hidden="true" />
              {t("agents.updateTo", { version: update.latest })}
            </button>
          )}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[length:var(--text-small)] text-[var(--app-text-tertiary)]">
          <span
            aria-hidden="true"
            className={cn("size-1.5 shrink-0 rounded-full", usingOwn ? "bg-[var(--app-text-tertiary)]" : "bg-[var(--app-status-success)]")}
          />
          <span className="truncate" title={tool.path ?? undefined}>{status}</span>
          {effectiveProvider && <PurityBadge provider={effectiveProvider} />}
        </div>
      </div>
      <Select value={effectiveProviderId} onValueChange={onChangeProvider}>
        <SelectTrigger
          aria-label={t("agents.providerLabel", { name: tool.displayName })}
          className="h-9 w-56 shrink-0 max-md:w-40"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={SYSTEM_PROVIDER_ID}>{t("agents.ownSettings")}</SelectItem>
          {providers.map((provider) => (
            <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button type="button" variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={onLaunch}>
        <Play className="size-3.5" aria-hidden="true" />
        {t("agents.launch")}
      </Button>
    </li>
  );
}
