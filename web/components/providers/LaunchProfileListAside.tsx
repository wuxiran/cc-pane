import { useTranslation } from "react-i18next";
import { Layers3, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { LaunchProfile } from "@/types";
import type { Provider } from "@/types/provider";
import type { KnownCliTool } from "@/types/terminal";
import type { Workspace } from "@/types/workspace";
import {
  WORKSPACE_FILTER_ALL,
  launchEnvironmentLabel,
  profileDisplayName,
  runtimeLabel,
  toolLabel,
} from "./launchProfileHelpers";

interface LaunchProfileListAsideProps {
  compact?: boolean;
  activeTool: KnownCliTool;
  workspaces: Workspace[];
  workspaceContext: Workspace | null;
  workspaceFilterName: string;
  onWorkspaceFilterChange: (name: string) => void;
  workspaceBoundProfileIds: Set<string>;
  providers: Provider[];
  filteredProfiles: LaunchProfile[];
  selectedId: string | null;
  isSystemDefaultSelected: boolean;
  onCopySystemDefault: () => void;
  onSelectSystemDefault: () => void;
  onSelect: (profile: LaunchProfile) => void;
}

export default function LaunchProfileListAside({
  compact,
  activeTool,
  workspaces,
  workspaceContext,
  workspaceFilterName,
  onWorkspaceFilterChange,
  workspaceBoundProfileIds,
  providers,
  filteredProfiles,
  selectedId,
  isSystemDefaultSelected,
  onCopySystemDefault,
  onSelectSystemDefault,
  onSelect,
}: LaunchProfileListAsideProps) {
  const { t } = useTranslation(["providers", "common"]);

  return (
    <aside
      className={cn(
        "shrink-0 overflow-y-auto border-r border-border bg-[var(--app-panel-bg)]/50",
        compact ? "w-64" : "w-80",
      )}
    >
      <div className="border-b border-border px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <span className="truncate">{t("profileListTitle", { tool: toolLabel(activeTool, t) })}</span>
          </div>
          <Button size="xs" variant="outline" onClick={onCopySystemDefault}>
            <Plus size={12} /> {t("add")}
          </Button>
        </div>
        <div className="mt-1 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
          {workspaceContext ? t("listScopeWorkspace", { name: workspaceContext.name }) : t("listScopeAll")}
        </div>
        <Select value={workspaceFilterName} onValueChange={onWorkspaceFilterChange}>
          <SelectTrigger size="sm" className="mt-3" aria-label={t("workspace")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={WORKSPACE_FILTER_ALL}>{t("allWorkspaces")}</SelectItem>
            {workspaces.map((workspace) => (
              <SelectItem key={workspace.id} value={workspace.name}>
                {workspace.alias || workspace.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="p-2">
        <button
          className={cn(
            "w-full rounded-lg border px-3 py-3 text-left transition-colors hover:bg-[var(--app-hover)]",
            isSystemDefaultSelected && "shadow-sm",
          )}
          style={{
            borderColor: isSystemDefaultSelected ? "var(--app-accent)" : "var(--app-border)",
            background: isSystemDefaultSelected ? "color-mix(in srgb, var(--app-accent) 10%, transparent)" : "transparent",
          }}
          onClick={onSelectSystemDefault}
        >
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">
              {t("systemDefaultName", { tool: toolLabel(activeTool, t) })}
            </span>
            <Badge variant="secondary" className="text-[10px]">{t("common:default")}</Badge>
          </div>
          <div className="mt-1 text-xs leading-5" style={{ color: "var(--app-text-secondary)" }}>
            {t("systemDefaultCardHint")}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className="rounded-md border border-border px-1.5 py-0.5 text-[10px]">CC-Panes MCP</span>
            <span className="rounded-md border border-border px-1.5 py-0.5 text-[10px]">{t("coreSkillTag")}</span>
          </div>
        </button>

        <div className="my-3 h-px bg-border" />

        <div className="space-y-2">
          {filteredProfiles.map((profile) => (
            <button
              key={profile.id}
              data-current={selectedId === profile.id ? "true" : undefined}
              className="w-full rounded-lg border px-3 py-3 text-left transition-colors hover:bg-[var(--app-hover)]"
              style={{
                borderColor: selectedId === profile.id ? "var(--app-accent)" : "var(--app-border)",
                background: selectedId === profile.id ? "color-mix(in srgb, var(--app-accent) 8%, transparent)" : "transparent",
              }}
              onClick={() => onSelect(profile)}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{profileDisplayName(profile)}</span>
                {profile.isDefault && <Badge variant="secondary" className="text-[10px]">{t("common:default")}</Badge>}
                {workspaceContext && workspaceBoundProfileIds.has(profile.id) && (
                  <Badge variant="outline" className="text-[10px]">{t("workspaceBadge")}</Badge>
                )}
              </div>
              <div className="mt-1 truncate text-xs" style={{ color: "var(--app-text-secondary)" }}>
                {providers.find((p) => p.id === profile.providerId)?.name ?? t("noProviderSpecified")}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>
                <span>{launchEnvironmentLabel(profile.targetTools, activeTool, t)}</span>
                <span className="rounded-md border border-border px-1.5 py-0.5">
                  {runtimeLabel(profile.targetRuntime ?? null, t)}
                </span>
              </div>
            </button>
          ))}
        </div>

        {filteredProfiles.length === 0 && (
          <EmptyState
            icon={Layers3}
            title={workspaceContext ? t("listEmptyWorkspace") : t("listEmptyAll")}
            className="py-6"
            action={{ label: t("listEmptyAction"), onClick: onCopySystemDefault }}
          />
        )}
      </div>
    </aside>
  );
}
