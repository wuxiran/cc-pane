import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Plus, Zap, Wrench, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useProvidersStore, useWorkspacesStore, useDialogStore, useSshMachinesStore } from "@/stores";
import ProviderCard from "./ProviderCard";
import ProviderFormPanel from "./ProviderFormPanel";
import ProviderToolTabs from "./ProviderToolTabs";
import type { Provider, ProviderPreset } from "@/types/provider";
import { getCompatibleCliTools, CLI_TOOL_TABS } from "@/types/provider";
import type { KnownCliTool } from "@/types/terminal";
import { PROVIDER_PRESETS, PRESET_CATEGORIES } from "@/constants/providerPresets";
import {
  getWorkspaceLaunchIssueKey,
  getWorkspaceLaunchIssueValues,
  resolveWorkspaceLaunchOptions,
} from "@/utils";

type PanelView = "list" | "preset_pick" | "form";

interface Props {
  compact?: boolean;
}

export default function ProvidersPanel({ compact }: Props = {}) {
  const { t } = useTranslation(["settings", "common"]);
  const providers = useProvidersStore((s) => s.providers);
  const sshMachines = useSshMachinesStore((s) => s.machines);
  const loadProviders = useProvidersStore((s) => s.loadProviders);
  const removeProvider = useProvidersStore((s) => s.removeProvider);
  const setDefault = useProvidersStore((s) => s.setDefault);

  const [view, setView] = useState<PanelView>("list");
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<ProviderPreset | null>(null);
  const [activeTab, setActiveTab] = useState<KnownCliTool>("claude");

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
                      className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm transition-all hover:shadow-sm"
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
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div
        className={`flex items-center justify-between shrink-0 ${compact ? "px-4 py-3" : "px-6 py-4"}`}
        style={{ borderBottom: "1px solid var(--app-border)" }}
      >
        <div className="flex items-center gap-2">
          <Zap size={compact ? 16 : 20} style={{ color: "var(--app-accent)" }} />
          <span className={`font-semibold ${compact ? "text-sm" : "text-base"}`} style={{ color: "var(--app-text-primary)" }}>
            Providers
          </span>
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

      {/* Provider list */}
      <div className="flex-1 overflow-y-auto">
        {filteredProviders.length === 0 ? (
          /* Empty state */
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <div
              className="w-16 h-16 rounded-2xl flex items-center justify-center"
              style={{ background: "var(--app-content)", border: "1px solid var(--app-border)" }}
            >
              <Zap size={32} style={{ color: "var(--app-text-tertiary)" }} />
            </div>
            <div className="text-center">
              <div className="text-sm font-medium mb-1" style={{ color: "var(--app-text-primary)" }}>
                {t("emptyTitle")}
              </div>
              <div className="text-xs max-w-[260px]" style={{ color: "var(--app-text-tertiary)" }}>
                {t("emptyDesc")}
              </div>
            </div>
            <div className="flex gap-2 mt-2">
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
        ) : (
          <div className={`mx-auto ${compact ? "px-4 py-3" : "max-w-3xl px-6 py-4"}`}>
            <div className="flex flex-col gap-3">
              {filteredProviders.map((p) => (
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
          </div>
        )}
      </div>
    </div>
  );
}
