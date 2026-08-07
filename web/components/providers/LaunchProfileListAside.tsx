import { useTranslation } from "react-i18next";
import { FolderKanban, Layers3, Plus } from "lucide-react";
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
  launchEnvironmentLabel,
  profileDisplayName,
  profileMatchesTool,
  runtimeLabel,
  SYSTEM_DEFAULT_PROFILE_ID,
  toolLabel,
} from "./launchProfileHelpers";

export type LaunchProfileListMode = "profiles" | "workspaces";

interface LaunchProfileListAsideProps {
  compact?: boolean;
  activeTool: KnownCliTool;
  workspaces: Workspace[];
  workspaceContext: Workspace | null;
  listMode: LaunchProfileListMode;
  onListModeChange: (mode: LaunchProfileListMode) => void;
  providers: Provider[];
  profiles: LaunchProfile[];
  filteredProfiles: LaunchProfile[];
  selectedId: string | null;
  isSystemDefaultSelected: boolean;
  onCopySystemDefault: () => void;
  onSelectSystemDefault: () => void;
  onSelect: (profile: LaunchProfile) => void;
  onSelectWorkspaceProfile: (workspace: Workspace, profile: LaunchProfile) => void;
  onSelectWorkspace: (workspace: Workspace) => void;
}

export default function LaunchProfileListAside({
  compact,
  activeTool,
  workspaces,
  workspaceContext,
  listMode,
  onListModeChange,
  providers,
  profiles,
  filteredProfiles,
  selectedId,
  isSystemDefaultSelected,
  onCopySystemDefault,
  onSelectSystemDefault,
  onSelect,
  onSelectWorkspaceProfile,
  onSelectWorkspace,
}: LaunchProfileListAsideProps) {
  const { t } = useTranslation(["providers", "common"]);

  if (compact) {
    const profileSelectValue = selectedId ?? SYSTEM_DEFAULT_PROFILE_ID;

    return (
      <aside className="shrink-0">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3 shadow-sm">
          <label className="min-w-0 space-y-1.5 text-xs">
            <span className="font-medium text-[var(--app-text-secondary)]">{t("savedProfilesTab")}</span>
            <Select
              value={profileSelectValue}
              onValueChange={(value) => {
                onListModeChange("profiles");
                if (value === SYSTEM_DEFAULT_PROFILE_ID) {
                  onSelectSystemDefault();
                  return;
                }
                const profile = filteredProfiles.find((item) => item.id === value);
                if (profile) onSelect(profile);
              }}
            >
              <SelectTrigger size="sm" aria-label={t("savedProfilesTab")}>
                <SelectValue placeholder={t("savedProfilesTab")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SYSTEM_DEFAULT_PROFILE_ID}>
                  {t("systemDefaultName", { tool: toolLabel(activeTool, t) })}
                </SelectItem>
                {filteredProfiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profileDisplayName(profile)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="min-w-0 space-y-1.5 text-xs">
            <span className="font-medium text-[var(--app-text-secondary)]">{t("workspaceListTab")}</span>
            <Select
              value={workspaceContext?.id}
              onValueChange={(value) => {
                const workspace = workspaces.find((item) => item.id === value);
                if (!workspace) return;
                onListModeChange("workspaces");
                onSelectWorkspace(workspace);
              }}
            >
              <SelectTrigger size="sm" aria-label={t("workspaceListTab")}>
                <SelectValue placeholder={t("workspaceListTab")} />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((workspace) => (
                  <SelectItem key={workspace.id} value={workspace.id}>
                    {workspace.alias || workspace.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <Button
            size="icon-sm"
            variant="outline"
            aria-label={t("add")}
            title={t("add")}
            onClick={onCopySystemDefault}
          >
            <Plus size={14} />
          </Button>
        </div>
      </aside>
    );
  }

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col overflow-hidden border-r border-border bg-[var(--app-panel-bg)]/50 max-[760px]:h-[220px] max-[760px]:w-full max-[760px]:border-b max-[760px]:border-r-0",
        "w-72",
      )}
    >
      <div className="shrink-0 border-b border-border px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold">{t("profileLibraryTitle")}</span>
          <Button size="xs" variant="outline" onClick={onCopySystemDefault}>
            <Plus size={12} /> {t("add")}
          </Button>
        </div>

        <div
          role="tablist"
          aria-label={t("profileListMode")}
          className="mt-2 grid grid-cols-2 gap-1 rounded-md bg-[var(--app-hover)] p-1"
        >
          <button
            type="button"
            role="tab"
            aria-selected={listMode === "profiles"}
            data-state={listMode === "profiles" ? "active" : "inactive"}
            className="flex h-7 min-w-0 items-center justify-center gap-1.5 rounded px-2 text-xs font-medium text-[var(--app-text-secondary)] transition-colors data-[state=active]:bg-[var(--app-panel-bg)] data-[state=active]:text-[var(--app-text-primary)] data-[state=active]:shadow-sm"
            onClick={() => onListModeChange("profiles")}
          >
            <Layers3 size={13} className="shrink-0" />
            <span className="truncate">{t("savedProfilesTab")}</span>
            <span className="tabular-nums text-[10px] text-[var(--app-text-tertiary)]">
              {filteredProfiles.length}
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={listMode === "workspaces"}
            data-state={listMode === "workspaces" ? "active" : "inactive"}
            className="flex h-7 min-w-0 items-center justify-center gap-1.5 rounded px-2 text-xs font-medium text-[var(--app-text-secondary)] transition-colors data-[state=active]:bg-[var(--app-panel-bg)] data-[state=active]:text-[var(--app-text-primary)] data-[state=active]:shadow-sm"
            onClick={() => onListModeChange("workspaces")}
          >
            <FolderKanban size={13} className="shrink-0" />
            <span className="truncate">{t("workspaceListTab")}</span>
            <span className="tabular-nums text-[10px] text-[var(--app-text-tertiary)]">
              {workspaces.length}
            </span>
          </button>
        </div>

      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {listMode === "profiles" ? (
          <>
            <button
              type="button"
              className="w-full rounded-md border px-3 py-2 text-left transition-colors hover:bg-[var(--app-hover)]"
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
              <div className="mt-0.5 truncate text-[11px] text-[var(--app-text-secondary)]">
                {t("systemDefaultCardHint")}
              </div>
            </button>

            <div className="mt-2 space-y-1.5">
              {filteredProfiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  data-current={selectedId === profile.id ? "true" : undefined}
                  className="w-full rounded-md border px-3 py-2 text-left transition-colors hover:bg-[var(--app-hover)]"
                  style={{
                    borderColor: selectedId === profile.id ? "var(--app-accent)" : "var(--app-border)",
                    background: selectedId === profile.id ? "color-mix(in srgb, var(--app-accent) 8%, transparent)" : "transparent",
                  }}
                  onClick={() => onSelect(profile)}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {profileDisplayName(profile)}
                    </span>
                    {profile.isDefault && (
                      <Badge variant="secondary" className="text-[10px]">{t("common:default")}</Badge>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-[var(--app-text-secondary)]">
                    {providers.find((provider) => provider.id === profile.providerId)?.name ?? t("noProviderSpecified")}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--app-text-tertiary)]">
                    <span>{launchEnvironmentLabel(profile.targetTools, activeTool, t)}</span>
                    <span className="rounded border border-border px-1.5 py-0.5">
                      {runtimeLabel(profile.targetRuntime ?? null, t)}
                    </span>
                  </div>
                </button>
              ))}
            </div>

            {!compact && filteredProfiles.length === 0 && (
              <div className="mt-2 rounded-md border border-dashed border-[var(--app-border)] px-3 py-3">
                <p className="text-[11px] leading-4 text-[var(--app-text-secondary)]">
                  {t("listEmptyAll")}
                </p>
                <Button size="xs" variant="outline" className="mt-2" onClick={onCopySystemDefault}>
                  <Plus size={12} /> {t("listEmptyAction")}
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="space-y-1.5">
              {workspaces.map((workspace) => {
                const boundProfile = workspace.launchProfileId
                  ? profiles.find((profile) => profile.id === workspace.launchProfileId) ?? null
                  : null;
                const compatibleBoundProfile = boundProfile && profileMatchesTool(boundProfile, activeTool)
                  ? boundProfile
                  : null;
                const projectBindingCount = workspace.projects.filter(
                  (project) => Boolean(project.launchProfileId),
                ).length;
                const projectProfiles = workspace.projects.flatMap((project) => {
                  if (!project.launchProfileId) return [];
                  const profile = profiles.find((candidate) => candidate.id === project.launchProfileId);
                  return profile ? [{ project, profile }] : [];
                });
                const selected = workspaceContext?.id === workspace.id;

                return (
                  <div
                    key={workspace.id}
                    className="rounded-md border p-1"
                    style={{
                      borderColor: selected ? "var(--app-accent)" : "var(--app-border)",
                      background: selected ? "color-mix(in srgb, var(--app-accent) 8%, transparent)" : "transparent",
                    }}
                  >
                    <button
                      type="button"
                      data-current={selected ? "true" : undefined}
                      className="w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-[var(--app-hover)]"
                      onClick={() => onSelectWorkspace(workspace)}
                    >
                      <div className="flex items-center gap-2">
                        <FolderKanban size={14} className="shrink-0 text-[var(--app-text-tertiary)]" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {workspace.alias || workspace.name}
                        </span>
                        {selected && <Badge variant="outline" className="text-[10px]">{t("currentWorkspace")}</Badge>}
                      </div>
                      <div className="mt-1 truncate pl-[22px] text-[11px] text-[var(--app-text-secondary)]">
                        {compatibleBoundProfile
                          ? profileDisplayName(compatibleBoundProfile)
                          : boundProfile
                            ? t("workspaceProfileOtherCli", {
                                name: profileDisplayName(boundProfile),
                                tool: toolLabel(activeTool, t),
                              })
                            : t("workspaceUsesDefault", { tool: toolLabel(activeTool, t) })}
                      </div>
                      <div className="mt-1.5 flex gap-2 pl-[22px] text-[10px] text-[var(--app-text-tertiary)]">
                        <span>{t("workspaceProjectCount", { count: workspace.projects.length })}</span>
                        {projectBindingCount > 0 && (
                          <span>{t("workspaceProjectBindings", { count: projectBindingCount })}</span>
                        )}
                      </div>
                    </button>
                    {projectProfiles.length > 0 && (
                      <div className="mt-1 space-y-0.5 border-t border-[var(--app-border)]/60 px-1 pt-1">
                        {projectProfiles.map(({ project, profile }) => {
                          const compatible = profileMatchesTool(profile, activeTool);
                          const projectLabel = project.alias || project.path;
                          return (
                            <button
                              key={project.id}
                              type="button"
                              disabled={!compatible}
                              className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left text-[11px] transition-colors hover:bg-[var(--app-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                              onClick={() => onSelectWorkspaceProfile(workspace, profile)}
                              title={project.path}
                            >
                              <span className="min-w-0 flex-1 truncate">{projectLabel}</span>
                              <span className="max-w-[46%] truncate text-[10px] text-[var(--app-text-secondary)]">
                                {profileDisplayName(profile)}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {workspaces.length === 0 && (
              <EmptyState icon={FolderKanban} title={t("noWorkspaces")} className="py-6" />
            )}
          </>
        )}
      </div>
    </aside>
  );
}
