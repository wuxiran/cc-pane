import { useState, useMemo, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Star, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useProvidersStore } from "@/stores";
import { ProviderAvatar } from "@/components/providers";
import ProviderToolTabs from "@/components/providers/ProviderToolTabs";
import { getCompatibleCliTools, CLI_TOOL_TABS } from "@/types/provider";
import type { Provider } from "@/types/provider";
import type { KnownCliTool } from "@/types/terminal";

export default function ProvidersView() {
  const { t } = useTranslation(["settings", "sidebar"]);
  const providers = useProvidersStore((s) => s.providers);
  const loadProviders = useProvidersStore((s) => s.loadProviders);
  const removeProvider = useProvidersStore((s) => s.removeProvider);
  const setDefault = useProvidersStore((s) => s.setDefault);

  const [activeTab, setActiveTab] = useState<KnownCliTool>("claude");

  useEffect(() => { loadProviders(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const providerCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const tab of CLI_TOOL_TABS) { counts[tab.id] = 0; }
    for (const p of providers) {
      for (const tool of getCompatibleCliTools(p.providerType)) {
        if (counts[tool] !== undefined) counts[tool]++;
      }
    }
    return counts;
  }, [providers]);

  const filteredProviders = useMemo(() =>
    providers.filter((p) => getCompatibleCliTools(p.providerType).includes(activeTab)),
    [providers, activeTab],
  );

  const handleDelete = useCallback(async (id: string) => {
    try {
      await removeProvider(id);
      toast.success(t("providerDeleted"));
    } catch (e) {
      toast.error(String(e));
    }
  }, [removeProvider, t]);

  const handleSetDefault = useCallback(async (id: string) => {
    try {
      await setDefault(id);
      toast.success(t("setAsDefault"));
    } catch (e) {
      toast.error(String(e));
    }
  }, [setDefault, t]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 shrink-0" style={{ borderBottom: "1px solid var(--app-border)" }}>
        <span className="text-xs font-semibold" style={{ color: "var(--app-text-primary)" }}>
          {t("sidebar:providers", { defaultValue: "Providers" })}
        </span>
      </div>

      {/* Tab bar */}
      <div className="px-3 py-1.5 shrink-0" style={{ borderBottom: "1px solid var(--app-border)" }}>
        <ProviderToolTabs
          activeTab={activeTab}
          onTabChange={setActiveTab}
          providerCounts={providerCounts}
          compact
        />
      </div>

      {/* Provider list */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {filteredProviders.length === 0 ? (
          <div className="flex items-center justify-center h-20 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
            {t("noProviders")}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {filteredProviders.map((p) => (
              <ProviderListItem
                key={p.id}
                provider={p}
                onDelete={handleDelete}
                onSetDefault={handleSetDefault}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProviderListItem({ provider, onDelete, onSetDefault }: {
  provider: Provider;
  onDelete: (id: string) => void;
  onSetDefault: (id: string) => void;
}) {
  const { t } = useTranslation("settings");

  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 rounded-md group hover:bg-[var(--app-hover)] transition-colors"
    >
      <ProviderAvatar name={provider.name} providerType={provider.providerType} size={24} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium truncate" style={{ color: "var(--app-text-primary)" }}>
            {provider.name}
          </span>
          {provider.isDefault && (
            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">
              {t("defaultBadge")}
            </Badge>
          )}
        </div>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {!provider.isDefault && (
          <button
            className="p-1 rounded hover:bg-[var(--app-hover)]"
            style={{ color: "var(--app-text-tertiary)" }}
            onClick={() => onSetDefault(provider.id)}
            title={t("setAsDefaultBtn")}
          >
            <Star size={12} />
          </button>
        )}
        <button
          className="p-1 rounded hover:bg-[var(--app-hover)]"
          style={{ color: "var(--app-text-tertiary)" }}
          onClick={() => onDelete(provider.id)}
          title={t("deleteBtn")}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}
