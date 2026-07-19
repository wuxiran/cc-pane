import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Plus, Zap, Wrench, ArrowLeft, Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  usePanesStore,
  useProvidersStore,
  useSettingsStore,
  useWorkspacesStore,
} from "@/stores";
import ProviderCard, { type SystemProbeInfo } from "./ProviderCard";
import ProviderFormPanel from "./ProviderFormPanel";
import ProviderToolTabs from "./ProviderToolTabs";
import LaunchProfilesPanel from "./LaunchProfilesPanel";
import type { Provider, ProviderPreset } from "@/types/provider";
import {
  getCompatibleCliTools,
  CLI_TOOL_TABS,
  createSystemProvider,
} from "@/types/provider";
import type { KnownCliTool, Tab } from "@/types/terminal";
import type { LaunchProfileRuntime, Workspace } from "@/types";
import { PROVIDER_PRESETS, PRESET_CATEGORIES } from "@/constants/providerPresets";
import { coerceCliTool, getWorkspaceDefaultEnvironment } from "@/utils";

type PanelView = "list" | "preset_pick" | "form";
type TopView = "providers" | "profiles";

interface Props {
  compact?: boolean;
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
  const systemEnvKeys = useProvidersStore((s) => s.systemEnvKeys);
  const systemCcSwitch = useProvidersStore((s) => s.systemCcSwitch);
  const defaultIsSystem = useProvidersStore((s) => s.defaultIsSystem);
  const activePane = usePanesStore((s) => s.activePane());
  const selectedWorkspace = useWorkspacesStore((s) => s.selectedWorkspace());
  const defaultCliTool = useSettingsStore((s) => s.settings?.general.defaultCliTool);
  const launcherShortcut = useSettingsStore(
    (s) => s.settings?.shortcuts.bindings["new-tab"],
  ) ?? "Ctrl+T";
  const loadProviders = useProvidersStore((s) => s.loadProviders);
  const removeProvider = useProvidersStore((s) => s.removeProvider);
  const setDefault = useProvidersStore((s) => s.setDefault);
  const activeTerminalTab = activePane?.tabs.find((tab) => tab.id === activePane.activeTabId) ?? null;
  const launchDefaults = useMemo(() => ({
    tool: coerceCliTool(activeTerminalTab?.cliTool ? String(activeTerminalTab.cliTool) : null)
      ?? (activeTerminalTab?.launchClaude ? "claude" : null)
      ?? coerceCliTool(defaultCliTool)
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
  // 「是否默认」不再 render 现算，直接读后端持久化的 defaultIsSystem——旧派生式判定
  // 只要存在任一默认 provider 就被打掉，但系统卡仍置顶，造成「它是默认」的误读。
  const systemProvider = useMemo(
    () => createSystemProvider(t("systemProviderName"), defaultIsSystem),
    [t, defaultIsSystem],
  );
  // 宿主进程级探测（cc-switch / 宿主 ANTHROPIC_*）只代表本机，WSL/SSH 下不适用。
  const systemProbe = useMemo<SystemProbeInfo>(() => {
    const runtime = launchDefaults.runtime;
    return {
      envKeys: systemEnvKeys,
      ccSwitch: systemCcSwitch,
      runtimeApplicable: runtime === "local" || runtime == null,
      runtimeLabel: runtime === "wsl" ? "WSL" : runtime === "ssh" ? "SSH" : undefined,
    };
  }, [systemEnvKeys, systemCcSwitch, launchDefaults.runtime]);
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
          <Button size="sm" variant="default">{t("launchProfilesTab")}</Button>
          <Button size="sm" variant="outline" onClick={() => setTopView("providers")}>
            {t("providerCredentialsTab")}
          </Button>
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
          <Button size="sm" variant="outline" onClick={() => setTopView("profiles")}>
            {t("launchProfilesTab")}
          </Button>
          <Button size="sm" variant="default">{t("providerCredentialsTab")}</Button>
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

      {/* 本面板只管理凭证；启动会话走全局启动器（删除卡上启动按钮后需明示，避免误以为功能丢失） */}
      <div
        className={`flex items-start gap-2 shrink-0 text-xs ${compact ? "px-4 py-2" : "px-6 py-2.5"}`}
        style={{ borderBottom: "1px solid var(--app-border)", color: "var(--app-text-tertiary)" }}
      >
        <Keyboard size={13} className="mt-0.5 shrink-0" />
        <span>{t("providerLaunchHint", { shortcut: launcherShortcut })}</span>
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
                onDuplicate={handleDuplicate}
                systemProbe={p.id === systemProvider.id ? systemProbe : undefined}
              />
            ))}
          </div>

          {filteredProviders.length === 0 && (
            <EmptyState
              icon={Zap}
              title={t("emptyTitle")}
              description={t("emptyDesc")}
              className="mt-2"
              action={{ label: t("fromPreset"), onClick: () => setView("preset_pick") }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
