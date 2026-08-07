import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Zap, Wrench, ArrowLeft, ArrowRight, Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  useLaunchProfilesStore,
  usePanesStore,
  useProvidersStore,
  useSettingsStore,
  useWorkspacesStore,
} from "@/stores";
import ProviderCard, { type SystemProbeInfo } from "./ProviderCard";
import ProviderFormPanel from "./ProviderFormPanel";
import ProviderPagesHeader, { type ProviderTopView } from "./ProviderPagesHeader";
import LaunchProfilesPanel from "./LaunchProfilesPanel";
import { countProfilesPerTool } from "./launchProfileHelpers";
import type { Provider, ProviderPreset } from "@/types/provider";
import { CLI_TOOL_TABS, createSystemProvider, SYSTEM_PROVIDER_ID } from "@/types/provider";
import { useCliTools } from "@/hooks/useCliTools";
import type { KnownCliTool, Tab } from "@/types/terminal";
import type { LaunchProfileRuntime, Workspace } from "@/types";
import { PROVIDER_PRESETS, PRESET_CATEGORIES } from "@/constants/providerPresets";
import { coerceCliTool, getWorkspaceDefaultEnvironment } from "@/utils";
import {
  compatibleCliToolsForProviderType,
  isProviderTypeCompatibleWithCli,
} from "@/utils/providerCompatibility";

type PanelView = "list" | "preset_pick" | "form";
type TopView = ProviderTopView;
type FormReturnView = Exclude<PanelView, "form">;

interface Props {
  compact?: boolean;
  /** Settings pages can pin one view and omit the in-panel view switcher. */
  view?: ProviderTopView;
}

function inferLaunchRuntime(tab: Tab | null, workspace?: Workspace | null): LaunchProfileRuntime {
  if (tab?.ssh) return "ssh";
  if (tab?.wsl) return "wsl";
  if (tab?.contentType === "terminal" && (tab.projectPath || tab.sessionId || tab.resumeId || tab.workspacePath)) {
    return "local";
  }
  return workspace ? getWorkspaceDefaultEnvironment(workspace) : null;
}

export default function ProvidersPanel({ compact, view: fixedTopView }: Props = {}) {
  const { t } = useTranslation(["settings", "common"]);
  const providers = useProvidersStore((s) => s.providers);
  const { tools: cliTools } = useCliTools();
  const systemEnvKeys = useProvidersStore((s) => s.systemEnvKeys);
  const systemCcSwitch = useProvidersStore((s) => s.systemCcSwitch);
  const defaultProviderIds = useProvidersStore((s) => s.defaultProviderIds);
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
  const [formReturnView, setFormReturnView] = useState<FormReturnView>("list");
  const [topView, setTopView] = useState<TopView>(fixedTopView ?? "profiles");
  const activeTopView = fixedTopView ?? topView;
  const launchProfiles = useLaunchProfilesStore((s) => s.profiles);
  const profileCounts = useMemo(() => countProfilesPerTool(launchProfiles), [launchProfiles]);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [duplicateSeed, setDuplicateSeed] = useState<Provider | null>(null);
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
      const tools = compatibleCliToolsForProviderType(
        p.providerType,
        cliTools,
        CLI_TOOL_TABS.map((tab) => tab.id),
      );
      for (const tool of tools) {
        if (counts[tool] !== undefined) {
          counts[tool]++;
        }
      }
    }
    return counts;
  }, [cliTools, providers]);

  // Filter providers for current tab
  const filteredProviders = useMemo(() =>
    providers.filter((p) => isProviderTypeCompatibleWithCli(p.providerType, activeTab, cliTools)),
    [providers, activeTab, cliTools],
  );

  // 合成「系统环境变量」条目：置顶、跨所有 CLI Tab 可用（选它 = 不注入、跟随系统/cc-switch）。
  // 「是否默认」不再 render 现算，直接读后端持久化的 defaultIsSystem——旧派生式判定
  // 只要存在任一默认 provider 就被打掉，但系统卡仍置顶，造成「它是默认」的误读。
  const systemProvider = useMemo(
    () => createSystemProvider(
      t("systemProviderName"),
      defaultProviderIds[activeTab] === SYSTEM_PROVIDER_ID,
    ),
    [activeTab, defaultProviderIds, t],
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
    () => [
      systemProvider,
      ...filteredProviders.map((provider) => ({
        ...provider,
        isDefault: defaultProviderIds[activeTab] === provider.id,
      })),
    ],
    [activeTab, defaultProviderIds, systemProvider, filteredProviders],
  );

  // Filter presets for current tab
  const filteredPresets = useMemo(() =>
    PROVIDER_PRESETS.filter((preset) => {
      // If preset has explicit compatibleCliTools, use that
      if (preset.compatibleCliTools) {
        return preset.compatibleCliTools.includes(activeTab);
      }
      // Otherwise derive from providerType
      return isProviderTypeCompatibleWithCli(preset.providerType, activeTab, cliTools);
    }),
    [activeTab, cliTools],
  );

  const handleEdit = useCallback((p: Provider) => {
    setEditingProvider(p);
    setDuplicateSeed(null);
    setSelectedPreset(null);
    setFormReturnView("list");
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
      await setDefault(id, activeTab);
      toast.success(t("setAsDefault"));
    } catch (e) {
      toast.error(t("setDefaultFailed", { error: String(e) }));
    }
  }, [activeTab, setDefault, t]);

  const handleDuplicate = useCallback((p: Provider) => {
    const duplicated: Provider = {
      ...p,
      id: crypto.randomUUID(),
      name: `${p.name} (Copy)`,
      isDefault: false,
    };
    setDuplicateSeed(duplicated);
    setEditingProvider(null);
    setSelectedPreset(null);
    setFormReturnView("list");
    setView("form");
    toast.success(t("duplicated"));
  }, [t]);

  const handleSelectPreset = useCallback((preset: ProviderPreset) => {
    setSelectedPreset(preset);
    setEditingProvider(null);
    setDuplicateSeed(null);
    setFormReturnView("preset_pick");
    setView("form");
  }, []);

  const handleCustomNew = useCallback(() => {
    setSelectedPreset(null);
    setEditingProvider(null);
    setDuplicateSeed(null);
    setFormReturnView("preset_pick");
    setView("form");
  }, []);

  const handleReturnToList = useCallback(() => {
    setView("list");
    setEditingProvider(null);
    setDuplicateSeed(null);
    setSelectedPreset(null);
  }, []);

  const handleReturnFromForm = useCallback(() => {
    setView(formReturnView);
    setEditingProvider(null);
    setDuplicateSeed(null);
    setSelectedPreset(null);
  }, [formReturnView]);

  // ── Form view ──
  if (view === "form") {
    return (
      <ProviderFormPanel
        editProvider={editingProvider}
        duplicateSeed={duplicateSeed}
        preset={selectedPreset}
        activeTab={activeTab}
        compact={compact}
        onBack={handleReturnFromForm}
        onSaved={handleReturnToList}
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
      <div className="flex h-full flex-col overflow-hidden">
        <div className={`flex shrink-0 items-center gap-2 ${compact ? "py-2.5" : "px-6 py-3"}`}>
          <button
            type="button"
            aria-label={t("back", { ns: "common" })}
            className="flex size-8 items-center justify-center rounded-md text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
            onClick={handleReturnToList}
          >
            <ArrowLeft size={18} />
          </button>
          <h2 className="text-[14px] font-semibold" style={{ color: "var(--app-text-primary)" }}>
            {t("fromPreset")}
          </h2>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className={`mx-auto w-full ${compact ? "py-3" : "max-w-3xl px-6 py-5"}`}>
            <div className="mb-4 flex items-baseline justify-between gap-3">
              <p className="text-[13px] font-medium" style={{ color: "var(--app-text-primary)" }}>
                {t("selectPresetOrCustom")}
              </p>
              <span className="shrink-0 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                {t(CLI_TOOL_TABS.find((tab) => tab.id === activeTab)?.labelKey ?? "tabClaude")}
              </span>
            </div>

            <div className="flex flex-col gap-4">
              {grouped.map((group) => (
                <section key={group.key}>
                  <div className="mb-2 text-[11px] font-medium" style={{ color: "var(--app-text-tertiary)" }}>
                    {t(group.labelKey as never)}
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {group.presets.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        className="group flex min-h-16 items-center gap-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-3 py-2 text-left transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
                        onClick={() => handleSelectPreset(preset)}
                      >
                        <span
                          className="flex size-8 shrink-0 items-center justify-center rounded-md"
                          style={{ background: preset.accentColor ? `${preset.accentColor}20` : "var(--app-active-bg)" }}
                        >
                          <span
                            className="size-2.5 rounded-full"
                            style={{ background: preset.accentColor || "var(--app-text-tertiary)" }}
                          />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium" style={{ color: "var(--app-text-primary)" }}>
                            {t(preset.nameKey as never)}
                          </span>
                          <span className="mt-0.5 block truncate text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                            {t(preset.descKey as never)}
                          </span>
                        </span>
                        <ArrowRight size={15} className="shrink-0 text-[var(--app-text-tertiary)] transition-transform duration-[var(--dur-fast)] group-hover:translate-x-0.5" />
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>

            <div className="mt-5">
              <Button variant="outline" size="sm" onClick={handleCustomNew}>
                <Wrench size={14} />
                {t("manualConfig")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── List view (default) ──
  // 统一单行 header：segmented 子页切换 + CLI chips + 页面级动作，两个子页共用（data-settings-section 供设置搜索定位）
  const header = (
    <ProviderPagesHeader
      topView={activeTopView}
      onTopViewChange={setTopView}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      counts={activeTopView === "providers" ? providerCounts : profileCounts}
      compact={compact}
      showTopViewTabs={!fixedTopView}
    />
  );

  if (activeTopView === "profiles") {
    return (
      <div className="flex flex-col h-full overflow-hidden" data-settings-section="provider-root">
        {header}
        <div className="flex-1 min-h-0">
          <LaunchProfilesPanel
            compact={compact}
            tool={activeTab}
            initialRuntime={launchDefaults.runtime}
            onActiveToolChange={setActiveTab}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden" data-settings-section="provider-credentials-root">
      {header}

      {/* Provider list（「系统环境变量」恒置顶，故列表永不为空；无真实 provider 时在下方给引导） */}
      <div className="flex-1 overflow-y-auto">
        <div className={`mx-auto w-full ${compact ? "py-3" : "max-w-3xl px-6 py-4"}`}>
          {/* 本面板只管理凭证；启动会话走全局启动器（删除卡上启动按钮后需明示，避免误以为功能丢失） */}
          {!compact && (
            <div className="mb-3 flex items-start gap-2 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
              <Keyboard size={13} className="mt-0.5 shrink-0" />
              <span>{t("providerLaunchHint", { shortcut: launcherShortcut })}</span>
            </div>
          )}

          <div className="flex flex-col gap-2.5">
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
