import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Plus, Zap, Wrench, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useDialogStore,
  usePanesStore,
  useProvidersStore,
  useSettingsStore,
  useSshMachinesStore,
  useWorkspacesStore,
} from "@/stores";
import ProviderCard from "./ProviderCard";
import ProviderFormPanel from "./ProviderFormPanel";
import ProviderToolTabs from "./ProviderToolTabs";
import LaunchProfilesPanel from "./LaunchProfilesPanel";
import type { Provider, ProviderPreset } from "@/types/provider";
import {
  getCompatibleCliTools,
  CLI_TOOL_TABS,
  createSystemProvider,
  isSystemProvider,
} from "@/types/provider";
import type { KnownCliTool, Tab } from "@/types/terminal";
import type { LaunchProfileRuntime, Workspace } from "@/types";
import { PROVIDER_PRESETS, PRESET_CATEGORIES } from "@/constants/providerPresets";
import {
  getWorkspaceDefaultEnvironment,
  getWorkspaceLaunchIssueKey,
  getWorkspaceLaunchIssueValues,
  resolveWorkspaceLaunchOptions,
} from "@/utils";

type PanelView = "list" | "preset_pick" | "form";
type TopView = "providers" | "profiles";

interface Props {
  compact?: boolean;
}

const LAUNCH_TOOL_IDS = new Set<string>(CLI_TOOL_TABS.map((tab) => tab.id));

function coerceLaunchTool(tool?: string | null): KnownCliTool | null {
  if (!tool || tool === "none") return null;
  return LAUNCH_TOOL_IDS.has(tool) ? (tool as KnownCliTool) : null;
}

function inferLaunchRuntime(tab: Tab | null, workspace?: Workspace | null): LaunchProfileRuntime {
  if (tab?.ssh) return "ssh";
  if (tab?.wsl) return "wsl";
  if (tab?.contentType === "terminal" && (tab.projectPath || tab.sessionId || tab.resumeId || tab.workspacePath)) {
    return "local";
  }
  return workspace ? getWorkspaceDefaultEnvironment(workspace) : null;
}

export default function ProvidersPanel({ compact }: Props = {}) {
  const { t } = useTranslation(["settings", "common"]);
  const providers = useProvidersStore((s) => s.providers);
  const systemActive = useProvidersStore((s) => s.systemActive);
  const activePane = usePanesStore((s) => s.activePane());
  const selectedWorkspace = useWorkspacesStore((s) => s.selectedWorkspace());
  const defaultCliTool = useSettingsStore((s) => s.settings?.general.defaultCliTool);
  const sshMachines = useSshMachinesStore((s) => s.machines);
  const loadProviders = useProvidersStore((s) => s.loadProviders);
  const removeProvider = useProvidersStore((s) => s.removeProvider);
  const setDefault = useProvidersStore((s) => s.setDefault);
  const activeTerminalTab = activePane?.tabs.find((tab) => tab.id === activePane.activeTabId) ?? null;
  const launchDefaults = useMemo(() => ({
    tool: coerceLaunchTool(activeTerminalTab?.cliTool ? String(activeTerminalTab.cliTool) : null)
      ?? (activeTerminalTab?.launchClaude ? "claude" : null)
      ?? coerceLaunchTool(defaultCliTool)
      ?? "claude",
    runtime: inferLaunchRuntime(activeTerminalTab, selectedWorkspace),
  }), [activeTerminalTab, defaultCliTool, selectedWorkspace]);

  const [view, setView] = useState<PanelView>("list");
  const [topView, setTopView] = useState<TopView>("profiles");
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<ProviderPreset | null>(null);
  const [activeTab, setActiveTab] = useState<KnownCliTool>(() => launchDefaults.tool);

  useEffect(() => { loadProviders(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Count providers per CLI tool tab
  const providerCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const tab of CLI_TOOL_TABS) {
      counts[tab.id] = 0;
    }
    for (const p of providers) {
      const tools = getCompatibleCliTools(p.providerType);
      for (const tool of tools) {
        if (counts[tool] !== undefined) {
          counts[tool]++;
        }
      }
    }
    return counts;
  }, [providers]);

  // Filter providers for current tab
  const filteredProviders = useMemo(() =>
    providers.filter((p) => getCompatibleCliTools(p.providerType).includes(activeTab)),
    [providers, activeTab],
  );

  // 合成「系统环境变量」条目：置顶、跨所有 CLI Tab 可用（选它 = 不注入、跟随系统/cc-switch）。
  // 「自动默认」只在 cc-switch/宿主检测**真正代表目标环境**时才标记：
  // cc-switch 只改 Claude 配置，且检测是本机宿主进程级的——故仅限 Claude Tab + 本机运行环境，
  // Codex/Gemini 等其它 Tab 或 WSL/SSH 运行环境不自动默认（那里的宿主检测不可代表目标）。
  const systemIsDefault =
    systemActive
    && activeTab === "claude"
    && (launchDefaults.runtime === "local" || launchDefaults.runtime == null)
    && !providers.some((p) => p.isDefault);
  const systemProvider = useMemo(
    () => createSystemProvider(t("systemProviderName"), systemIsDefault),
    [t, systemIsDefault],
  );
  const displayProviders = useMemo(
    () => [systemProvider, ...filteredProviders],
    [systemProvider, filteredProviders],
  );

  // Filter presets for current tab
  const filteredPresets = useMemo(() =>
    PROVIDER_PRESETS.filter((preset) => {
      // If preset has explicit compatibleCliTools, use that
      if (preset.compatibleCliTools) {
        return preset.compatibleCliTools.includes(activeTab);
      }
      // Otherwise derive from providerType
      return getCompatibleCliTools(preset.providerType).includes(activeTab);
    }),
    [activeTab],
  );

  const handleEdit = useCallback((p: Provider) => {
    setEditingProvider(p);
    setSelectedPreset(null);
    setView("form");
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await removeProvider(id);
      toast.success(t("providerDeleted"));
    } catch (e) {
      toast.error(t("deleteFailed", { error: String(e) }));
    }
  }, [removeProvider, t]);

  const handleSetDefault = useCallback(async (id: string) => {
    try {
      await setDefault(id);
      toast.success(t("setAsDefault"));
    } catch (e) {
      toast.error(t("setDefaultFailed", { error: String(e) }));
    }
  }, [setDefault, t]);

  const handleLaunch = useCallback((providerId: string) => {
    const ws = useWorkspacesStore.getState().selectedWorkspace();
    if (!ws) {
      toast.error(t("selectWorkspaceFirst"));
      return;
    }
    const { options, issue } = resolveWorkspaceLaunchOptions({
      workspace: ws,
      providerId,
      machines: sshMachines,
    });
    if (!options || issue) {
      toast.error(t(getWorkspaceLaunchIssueKey(issue!), {
        ns: "sidebar",
        ...getWorkspaceLaunchIssueValues(issue!),
        defaultValue: {
          local_path_missing: "本机环境需要先设置工作空间路径。",
          wsl_unsupported: "当前平台不支持 WSL。",
          wsl_path_missing: "WSL 环境需要填写远端路径。",
          wsl_local_path_missing: "WSL 环境需要先设置本机工作空间路径。",
          ssh_machine_missing: "SSH 环境需要先选择机器。",
          ssh_machine_not_found: "找不到已保存的 SSH 机器：{{machineId}}",
          ssh_path_missing: "SSH 环境需要填写远端路径。",
        }[issue!.code],
      }));
      return;
    }
    useDialogStore.getState().setPendingLaunch({
      path: options.path,
      workspaceName: options.workspaceName,
      providerId,
      // 「系统环境变量」→ 不注入（none），后端 effective_provider_id 落 None；其余显式注入。
      providerSelection: isSystemProvider(providerId) ? "none" : "explicit",
      launchProfileId: options.launchProfileId,
      workspacePath: options.workspacePath,
      cliTool: activeTab,
      ssh: options.ssh,
      wsl: options.wsl,
      machineName: options.machineName,
    });
  }, [activeTab, sshMachines, t]);

  const handleDuplicate = useCallback((p: Provider) => {
    const duplicated: Provider = {
      ...p,
      id: crypto.randomUUID(),
      name: `${p.name} (Copy)`,
      isDefault: false,
    };
    setEditingProvider(duplicated);
    setSelectedPreset(null);
    setView("form");
    toast.success(t("duplicated"));
  }, [t]);

  const handleSelectPreset = useCallback((preset: ProviderPreset) => {
    setSelectedPreset(preset);
    setEditingProvider(null);
    setView("form");
  }, []);

  const handleCustomNew = useCallback(() => {
    setSelectedPreset(null);
    setEditingProvider(null);
    setView("form");
  }, []);

  const handleBack = useCallback(() => {
    setView("list");
    setEditingProvider(null);
    setSelectedPreset(null);
  }, []);

  // ── Form view ──
  if (view === "form") {
    return (
      <ProviderFormPanel
        editProvider={editingProvider}
        preset={selectedPreset}
        activeTab={activeTab}
        onBack={handleBack}
      />
    );
  }

  // ── Preset pick view ──
  if (view === "preset_pick") {
    const grouped = PRESET_CATEGORIES.map((cat) => ({
      ...cat,
      presets: filteredPresets.filter((p) => p.category === cat.key).sort((a, b) => a.order - b.order),
    })).filter((g) => g.presets.length > 0);

    return (
      <div className="flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div
          className="flex items-center gap-3 px-6 py-4 shrink-0"
          style={{ borderBottom: "1px solid var(--app-border)" }}
        >
          <button
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[var(--app-hover)] transition-colors"
            style={{ color: "var(--app-text-secondary)" }}
            onClick={handleBack}
          >
            <ArrowLeft size={18} />
          </button>
          <span className="text-base font-semibold" style={{ color: "var(--app-text-primary)" }}>
            {t("addProvider")}
          </span>
        </div>

        {/* Preset groups */}
        <div className="flex-1 overflow-y-auto">
          <div className={`mx-auto ${compact ? "px-4 py-4" : "max-w-3xl px-6 py-8"}`}>
            <p className="text-sm mb-6" style={{ color: "var(--app-text-secondary)" }}>
              {t("selectPresetOrCustom")}
            </p>

            {grouped.map((group) => (
              <div key={group.key} className="mb-6">
                <div className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--app-text-tertiary)" }}>
                  {t(group.labelKey as never)}
                </div>
                <div className="flex flex-wrap gap-2">
                  {group.presets.map((preset) => (
                    <button
                      key={preset.id}
                      className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm transition-all duration-[var(--dur-fast)] hover:shadow-sm"
                      style={{
                        border: "1px solid var(--app-border)",
                        background: "var(--app-content)",
                        color: "var(--app-text-primary)",
                      }}
                      onMouseEnter={(e) => {
                        if (preset.accentColor) {
                          (e.currentTarget as HTMLElement).style.borderColor = preset.accentColor;
                        }
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.borderColor = "var(--app-border)";
                      }}
                      onClick={() => handleSelectPreset(preset)}
                    >
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ background: preset.accentColor || "var(--app-text-tertiary)" }}
                      />
                      {t(preset.nameKey as never)}
                    </button>
                  ))}
                </div>
              </div>
            ))}

            {/* Custom separator */}
            <div className="flex items-center gap-3 my-6">
              <div className="flex-1 h-px" style={{ background: "var(--app-border)" }} />
              <span className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                {t("orCustom")}
              </span>
              <div className="flex-1 h-px" style={{ background: "var(--app-border)" }} />
            </div>

            <Button variant="outline" size="default" onClick={handleCustomNew}>
              <Wrench size={16} className="mr-2" />
              {t("manualConfig")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ── List view (default) ──
  if (topView === "profiles") {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div
          className={`flex items-center gap-2 shrink-0 ${compact ? "px-4 py-3" : "px-6 py-4"}`}
          style={{ borderBottom: "1px solid var(--app-border)" }}
        >
          <Button size="sm" variant="default">运行配置</Button>
          <Button size="sm" variant="outline" onClick={() => setTopView("providers")}>Provider 凭证</Button>
        </div>
        <div className="flex-1 min-h-0">
          <LaunchProfilesPanel
            compact={compact}
            initialTool={activeTab}
            initialRuntime={launchDefaults.runtime}
            onActiveToolChange={setActiveTab}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div
        className={`flex items-center justify-between shrink-0 ${compact ? "px-4 py-3" : "px-6 py-4"}`}
        style={{ borderBottom: "1px solid var(--app-border)" }}
      >
        <div className="flex items-center gap-2">
          <Zap size={compact ? 16 : 20} style={{ color: "var(--app-accent)" }} />
          <Button size="sm" variant="outline" onClick={() => setTopView("profiles")}>运行配置</Button>
          <Button size="sm" variant="default">Provider 凭证</Button>
        </div>
        <Button size="sm" onClick={() => setView("preset_pick")}>
          <Plus size={16} className="mr-1.5" />
          {t("fromPreset")}
        </Button>
      </div>

      {/* Tab bar */}
      <div
        className={`shrink-0 ${compact ? "px-4 py-2" : "px-6 py-3"}`}
        style={{ borderBottom: "1px solid var(--app-border)" }}
      >
        <ProviderToolTabs
          activeTab={activeTab}
          onTabChange={setActiveTab}
          providerCounts={providerCounts}
          compact={compact}
        />
      </div>

      {/* Provider list（「系统环境变量」恒置顶，故列表永不为空；无真实 provider 时在下方给引导） */}
      <div className="flex-1 overflow-y-auto">
        <div className={`mx-auto ${compact ? "px-4 py-3" : "max-w-3xl px-6 py-4"}`}>
          <div className="flex flex-col gap-3">
            {displayProviders.map((p) => (
              <ProviderCard
                key={p.id}
                provider={p}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onSetDefault={handleSetDefault}
                onLaunch={handleLaunch}
                onDuplicate={handleDuplicate}
              />
            ))}
          </div>

          {filteredProviders.length === 0 && (
            <div className="flex flex-col items-center gap-3 mt-8 text-center">
              <div className="text-xs max-w-[260px]" style={{ color: "var(--app-text-tertiary)" }}>
                {t("emptyDesc")}
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setView("preset_pick")}>
                  <Plus size={16} className="mr-1.5" />
                  {t("fromPreset")}
                </Button>
                <Button variant="outline" size="sm" onClick={handleCustomNew}>
                  <Wrench size={16} className="mr-1.5" />
                  {t("manualConfig")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
