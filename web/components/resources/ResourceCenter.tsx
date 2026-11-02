// 资源中心（docs/109）：按启动档统一管理资源。一期只有 MCP，Skills、Hooks 后续接入同一框架。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useWorkspacesStore } from "@/stores";
import { useLaunchProfilesStore } from "@/stores/useLaunchProfilesStore";
import type { McpLayerTarget } from "@/types";
import { handleErrorSilent } from "@/utils/errorHandler";
import McpResourceTab from "./McpResourceTab";
import { visibleProfiles } from "./resourceCenterModel";

const CHOSEN_PROFILES_KEY = "cc-panes.resourceCenter.profiles";
const NO_SCOPE = "__none__";

function readChosenProfiles(): string[] | null {
  try {
    const raw = localStorage.getItem(CHOSEN_PROFILES_KEY);
    const value: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : null;
  } catch {
    return null;
  }
}

function writeChosenProfiles(ids: readonly string[]) {
  try {
    localStorage.setItem(CHOSEN_PROFILES_KEY, JSON.stringify(ids));
  } catch {
    // 只是显示偏好，存不下就下次回到默认
  }
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export default function ResourceCenter() {
  const { t } = useTranslation("settings");
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const loadWorkspaces = useWorkspacesStore((s) => s.load);
  const profiles = useLaunchProfilesStore((s) => s.profiles);
  const loadProfiles = useLaunchProfilesStore((s) => s.load);

  const [scope, setScope] = useState<string>(NO_SCOPE);
  const [chosen, setChosen] = useState<string[] | null>(readChosenProfiles);

  useEffect(() => {
    loadProfiles().catch((error) => handleErrorSilent(error, "load launch profiles"));
    if (useWorkspacesStore.getState().workspaces.length === 0) {
      void Promise.resolve(loadWorkspaces()).catch((error) => handleErrorSilent(error, "load workspaces"));
    }
  }, [loadProfiles, loadWorkspaces]);

  const shown = useMemo(() => visibleProfiles(profiles, chosen), [profiles, chosen]);
  const shownIds = useMemo(() => new Set(shown.map((profile) => profile.id)), [shown]);

  const scopes = useMemo(
    () =>
      workspaces.flatMap((workspace) => [
        { value: `ws:${workspace.name}`, label: workspace.alias || workspace.name, indent: false },
        ...workspace.projects
          .filter((project) => !project.archivedAt)
          .map((project) => ({ value: `project:${project.path}`, label: project.alias || basename(project.path), indent: true })),
      ]),
    [workspaces],
  );

  const { layerTarget, layerLabel } = useMemo((): { layerTarget: McpLayerTarget | null; layerLabel: string | null } => {
    const label = scopes.find((item) => item.value === scope)?.label ?? null;
    if (scope.startsWith("ws:")) return { layerTarget: { workspaceName: scope.slice(3) }, layerLabel: label };
    if (scope.startsWith("project:")) return { layerTarget: { projectPath: scope.slice(8) }, layerLabel: label };
    return { layerTarget: null, layerLabel: null };
  }, [scope, scopes]);

  const toggleShown = (id: string, on: boolean) => {
    const next = on ? [...shownIds, id] : [...shownIds].filter((item) => item !== id);
    if (next.length === 0) return;
    setChosen(next);
    writeChosenProfiles(next);
  };

  return (
    <div className="space-y-4" data-testid="resource-center">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[13px] font-medium" style={{ color: "var(--app-text-primary)" }}>MCP</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={scope} onValueChange={setScope}>
            <SelectTrigger className="h-8 w-52 text-xs" aria-label={t("resourceCenter.scope")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_SCOPE}>{t("resourceCenter.scopeNone")}</SelectItem>
              {scopes.map((item) => (
                <SelectItem key={item.value} value={item.value} className={item.indent ? "pl-6" : undefined}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {profiles.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="h-8 text-xs">
                  {t("resourceCenter.shownProfiles", { shown: shown.length, total: profiles.length })}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {profiles.map((profile) => (
                  <DropdownMenuCheckboxItem
                    key={profile.id}
                    checked={shownIds.has(profile.id)}
                    onCheckedChange={(checked) => toggleShown(profile.id, checked === true)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {profile.alias || profile.name}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>
      <McpResourceTab profiles={shown} layerTarget={layerTarget} layerLabel={layerLabel} />
    </div>
  );
}
