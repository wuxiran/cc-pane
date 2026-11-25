// ACP 官方注册表浏览器：搜索、安装（物化为 engines.json 自定义引擎）、卸载。
// 内置引擎已覆盖的 agent（Claude / Codex / Kiro …）只标「内置」，不重复安装。
// 注册表条目是第三方代码：每行都给出仓库与许可证，安装前用户能看到来源。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ExternalLink, Loader2, Search, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { openUrl } from "@tauri-apps/plugin-opener";
import { agentChatService } from "@/services/agentChatService";
import { isTauriRuntime } from "@/services/runtime";
import { getErrorMessage } from "@/utils";
import { handleErrorSilent } from "@/utils/errorHandler";
import type { AcpRegistryAgentInfo } from "@/types/agentChat";

async function openExternal(url: string): Promise<void> {
  try {
    if (isTauriRuntime()) await openUrl(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  } catch (reason) {
    handleErrorSilent(reason, "open acp registry agent source");
  }
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 安装成功后回调新引擎 id（调用方刷新引擎列表并选中它） */
  onInstalled: (engineId: string) => void;
  /** 卸载后回调（调用方刷新引擎列表） */
  onUninstalled: () => void;
}

export default function AcpRegistryDialog({ open, onOpenChange, onInstalled, onUninstalled }: Props) {
  const { t } = useTranslation("panes");
  const [agents, setAgents] = useState<AcpRegistryAgentInfo[] | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadError(null);
    agentChatService
      .listRegistry()
      .then((listing) => {
        if (cancelled) return;
        setAgents(listing.agents);
        setFromCache(listing.fromCache);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(getErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!agents) return [];
    if (!needle) return agents;
    return agents.filter((agent) =>
      `${agent.name} ${agent.id} ${agent.description}`.toLowerCase().includes(needle),
    );
  }, [agents, query]);

  async function install(agent: AcpRegistryAgentInfo) {
    setBusyId(agent.id);
    setRowError(null);
    try {
      const engineId = await agentChatService.installRegistryAgent(agent.id);
      setAgents((list) =>
        list?.map((item) => (item.id === agent.id ? { ...item, installedVersion: item.version } : item)) ?? list,
      );
      onInstalled(engineId);
    } catch (error) {
      setRowError({ id: agent.id, message: getErrorMessage(error) });
    } finally {
      setBusyId(null);
    }
  }

  async function uninstall(agent: AcpRegistryAgentInfo) {
    setBusyId(agent.id);
    setRowError(null);
    try {
      await agentChatService.uninstallRegistryAgent(agent.id);
      setAgents((list) =>
        list?.map((item) => (item.id === agent.id ? { ...item, installedVersion: null } : item)) ?? list,
      );
      onUninstalled();
    } catch (error) {
      setRowError({ id: agent.id, message: getErrorMessage(error) });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-3 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("acpRegistry.title")}</DialogTitle>
          <DialogDescription>{t("acpRegistry.description")}</DialogDescription>
        </DialogHeader>

        <label className="flex items-center gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-input-bg)] px-2.5 focus-within:border-[var(--app-accent)]">
          <Search className="size-3.5 shrink-0 text-[var(--app-text-tertiary)]" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("acpRegistry.search")}
            aria-label={t("acpRegistry.search")}
            className="h-8 min-w-0 flex-1 bg-transparent text-[13px] text-[var(--app-text-primary)] placeholder:text-[var(--app-text-tertiary)] focus-visible:outline-none"
          />
        </label>

        {fromCache && (
          <p className="text-[11.5px] text-[var(--app-status-warning)]">{t("acpRegistry.offline")}</p>
        )}

        <div className="-mx-2 min-h-0 flex-1 overflow-y-auto" data-testid="acp-registry-list">
          {loadError ? (
            <p role="alert" className="px-2 py-6 text-center text-[12.5px] text-[var(--app-status-danger)]">
              {loadError}
            </p>
          ) : agents === null ? (
            <div className="flex justify-center py-8 text-[var(--app-text-tertiary)]">
              <Loader2 className="size-4 animate-spin" aria-label={t("acpRegistry.loading")} />
            </div>
          ) : visible.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12.5px] text-[var(--app-text-tertiary)]">
              {t("acpRegistry.empty")}
            </p>
          ) : (
            <ul className="flex flex-col">
              {visible.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  busy={busyId === agent.id}
                  disabled={busyId !== null && busyId !== agent.id}
                  error={rowError?.id === agent.id ? rowError.message : null}
                  onInstall={() => void install(agent)}
                  onUninstall={() => void uninstall(agent)}
                />
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AgentRow({
  agent,
  busy,
  disabled,
  error,
  onInstall,
  onUninstall,
}: {
  agent: AcpRegistryAgentInfo;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const { t } = useTranslation("panes");
  const link = agent.repository || agent.website;
  const installed = agent.installedVersion !== null;
  const outdated = installed && agent.installedVersion !== agent.version;

  let action: React.ReactNode;
  if (agent.builtInEngineId) {
    action = <span className="text-[11.5px] text-[var(--app-text-tertiary)]">{t("acpRegistry.builtIn")}</span>;
  } else if (!agent.distribution) {
    action = <span className="text-[11.5px] text-[var(--app-text-tertiary)]">{t("acpRegistry.unsupported")}</span>;
  } else if (installed && !outdated) {
    action = (
      <div className="flex items-center gap-1">
        <span className="flex items-center gap-1 text-[11.5px] text-[var(--app-status-success)]">
          <Check className="size-3.5" aria-hidden />
          {t("acpRegistry.installed")}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          disabled={busy || disabled}
          aria-label={t("acpRegistry.uninstall", { name: agent.name })}
          title={t("acpRegistry.uninstall", { name: agent.name })}
          onClick={onUninstall}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
        </Button>
      </div>
    );
  } else {
    action = (
      <Button size="sm" variant="secondary" className="h-7 px-3 text-[12px]" disabled={busy || disabled} onClick={onInstall}>
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {outdated ? t("acpRegistry.update") : t("acpRegistry.install")}
      </Button>
    );
  }

  return (
    <li className="flex items-start gap-3 rounded-lg px-2 py-2.5 hover:bg-[var(--app-hover)]" data-agent-id={agent.id}>
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[var(--app-hover)]">
        {agent.iconUrl ? (
          // 注册表图标是单色 SVG；放在中性底上，深浅主题都能看见。
          <img src={agent.iconUrl} alt="" className="size-5 dark:invert" loading="lazy" />
        ) : (
          <span className="text-[12px] font-semibold text-[var(--app-text-secondary)]">{agent.name.slice(0, 1)}</span>
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-[var(--app-text-primary)]">{agent.name}</span>
          {agent.featured && !agent.builtInEngineId && (
            <span className="shrink-0 rounded px-1.5 py-px text-[9.5px] font-semibold text-[var(--app-accent)]" style={{ background: "var(--app-active-bg)" }}>
              {t("acpRegistry.featured")}
            </span>
          )}
          <span className="shrink-0 text-[11px] tabular-nums text-[var(--app-text-tertiary)]">v{agent.version}</span>
        </div>
        {agent.description && (
          <p className="mt-0.5 line-clamp-2 text-[12px] leading-[1.45] text-[var(--app-text-secondary)]">{agent.description}</p>
        )}
        <p className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--app-text-tertiary)]">
          {agent.distribution && <span>{agent.distribution}</span>}
          {agent.license && <span>· {agent.license}</span>}
          {link && (
            <button
              type="button"
              onClick={() => void openExternal(link)}
              className="flex min-w-0 items-center gap-0.5 hover:text-[var(--app-accent)] hover:underline"
            >
              · <span className="truncate">{link.replace(/^https?:\/\//, "")}</span>
              <ExternalLink className="size-3 shrink-0" aria-hidden />
            </button>
          )}
        </p>
        {error && <p role="alert" className="mt-1 text-[11.5px] text-[var(--app-status-danger)]">{error}</p>}
      </div>
      <div className="flex shrink-0 items-center self-center">{action}</div>
    </li>
  );
}
