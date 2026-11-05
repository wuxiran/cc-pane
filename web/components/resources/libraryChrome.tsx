// 资源库各子页共用的页头部件：作用域选择、显示哪些启动档、启动档开关的标签和写入。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toolLabel, type ProfilesT } from "@/components/providers/launchProfileHelpers";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { workspaceNameForProject } from "@/hooks/useQuickCommandsSync";
import { toastErr } from "@/lib/feedback";
import { isTauriRuntime } from "@/services/runtime";
import { useWorkspacesStore } from "@/stores";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLaunchProfilesStore } from "@/stores/useLaunchProfilesStore";
import { useResourceLibraryStore } from "@/stores/useResourceLibraryStore";
import type { LaunchProfile, McpLayerTarget } from "@/types";
import { translateError } from "@/utils";
import { handleErrorSilent } from "@/utils/errorHandler";
import { visibleProfiles } from "./resourceCenterModel";
import { useProfilePolicyWriter } from "./useProfilePolicyWriter";

/** MCP 页和技能页共用：在一页里选过显示哪些启动档，另一页也一样 */
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

/** 外链：桌面走 opener，浏览器壳用新窗口 */
export async function openExternalUrl(url: string): Promise<void> {
  try {
    if (isTauriRuntime()) await openUrl(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  } catch (error) {
    handleErrorSilent(error, "open external url");
  }
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function scopeValue(scope: McpLayerTarget | null): string {
  if (scope?.workspaceName) return `ws:${scope.workspaceName}`;
  if (scope?.projectPath) return `project:${scope.projectPath}`;
  return NO_SCOPE;
}

export function profileName(profile: Pick<LaunchProfile, "alias" | "name">): string {
  return profile.alias || profile.name;
}

/** 开关上的文字：启动档名，只针对一个 CLI 时带上 CLI 名 */
export function profileChipLabel(profile: LaunchProfile, t: ProfilesT): string {
  return `${profileName(profile)}${profile.targetTools.length === 1 ? ` · ${toolLabel(profile.targetTools[0], t)}` : ""}`;
}

/** 当前作用域：选了项目时，工作空间取项目所属的那个 */
export function useResourceScope() {
  const scope = useResourceLibraryStore((s) => s.scope);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const projectPath = scope?.projectPath ?? null;
  const owningWorkspace = useMemo(
    () => (projectPath ? workspaceNameForProject(workspaces, projectPath) : undefined),
    [workspaces, projectPath],
  );
  const workspaceName = scope?.workspaceName ?? owningWorkspace ?? null;
  const workspace = useMemo(() => workspaces.find((item) => item.name === workspaceName), [workspaces, workspaceName]);
  return { scope, projectPath, owningWorkspace, workspaceName, workspace };
}

/**
 * 进入页面和窗口重新获得焦点时重读启动档（可能刚在设置窗口改过，两个窗口的 store 不通），
 * 再提供“显示哪些启动档”和乐观写入。
 */
export function useLibraryProfiles(active: boolean) {
  const { t } = useTranslation("settings");
  const profiles = useLaunchProfilesStore((s) => s.profiles);
  const loadProfiles = useLaunchProfilesStore((s) => s.load);
  const loadWorkspaces = useWorkspacesStore((s) => s.load);
  const [chosen, setChosen] = useState<string[] | null>(readChosenProfiles);

  const { overlay, apply } = useProfilePolicyWriter((error) => {
    toastErr(t("resourceCenter.saveFailed", { error: translateError(error) }));
    void loadProfiles();
  });

  useEffect(() => {
    if (!active) return;
    const refresh = () => {
      loadProfiles().catch((error) => handleErrorSilent(error, "load launch profiles"));
    };
    refresh();
    if (useWorkspacesStore.getState().workspaces.length === 0) {
      void Promise.resolve(loadWorkspaces()).catch((error) => handleErrorSilent(error, "load workspaces"));
    }
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [active, loadProfiles, loadWorkspaces]);

  const shown = useMemo(() => visibleProfiles(profiles, chosen), [profiles, chosen]);
  const shownIds = useMemo(() => new Set(shown.map((profile) => profile.id)), [shown]);
  const toggleShown = (id: string, on: boolean) => {
    const next = on ? [...shownIds, id] : [...shownIds].filter((item) => item !== id);
    if (next.length === 0) return;
    setChosen(next);
    writeChosenProfiles(next);
  };

  return { profiles, loadProfiles, shown, shownIds, toggleShown, overlay, apply };
}

export function ShownProfilesMenu({
  profiles,
  shownIds,
  onToggle,
}: {
  profiles: readonly LaunchProfile[];
  shownIds: ReadonlySet<string>;
  onToggle: (id: string, on: boolean) => void;
}) {
  const { t } = useTranslation("settings");
  if (profiles.length <= 1) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 text-xs">
          {t("resourceCenter.shownProfiles", { shown: shownIds.size, total: profiles.length })}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {profiles.map((profile) => (
          <DropdownMenuCheckboxItem
            key={profile.id}
            checked={shownIds.has(profile.id)}
            onCheckedChange={(checked) => onToggle(profile.id, checked === true)}
            onSelect={(event) => event.preventDefault()}
          >
            {profileName(profile)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 工作空间 / 项目作用域选择；返回当前作用域的显示名，给“添加到 X”之类的文案用 */
export function useScopeOptions() {
  const scope = useResourceLibraryStore((s) => s.scope);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const scopes = useMemo(
    () =>
      workspaces.filter((workspace) => !workspace.archivedAt).flatMap((workspace) => [
        { value: `ws:${workspace.name}`, label: workspace.alias || workspace.name, indent: false },
        ...workspace.projects
          .filter((project) => !project.archivedAt)
          .map((project) => ({ value: `project:${project.path}`, label: project.alias || basename(project.path), indent: true })),
      ]),
    [workspaces],
  );
  // 从 Agent Chat 跳来时 cwd 可能不是已登记的项目，也要能显示和取消
  const options = useMemo(() => {
    const value = scopeValue(scope);
    if (value === NO_SCOPE || scopes.some((item) => item.value === value)) return scopes;
    const label = scope?.workspaceName ?? basename(scope?.projectPath ?? "");
    return [...scopes, { value, label, indent: false }];
  }, [scope, scopes]);
  const label = options.find((item) => item.value === scopeValue(scope))?.label ?? null;
  return { options, label };
}

export function ScopeSelect({ onChange }: { onChange?: () => void }) {
  const { t } = useTranslation("settings");
  const scope = useResourceLibraryStore((s) => s.scope);
  const setScope = useResourceLibraryStore((s) => s.setScope);
  const { options } = useScopeOptions();
  const handleChange = (value: string) => {
    if (value.startsWith("ws:")) setScope({ workspaceName: value.slice(3) });
    else if (value.startsWith("project:")) setScope({ projectPath: value.slice(8) });
    else setScope(null);
    onChange?.();
  };
  return (
    <Select value={scopeValue(scope)} onValueChange={handleChange}>
      <SelectTrigger className="h-8 w-48 text-xs" aria-label={t("resourceCenter.scope")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_SCOPE}>{t("resourceCenter.scopeNone")}</SelectItem>
        {options.map((item) => (
          <SelectItem key={item.value} value={item.value} className={item.indent ? "pl-6" : undefined}>{item.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
