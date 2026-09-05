import { useCallback, useMemo, useState, type ButtonHTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ChevronRight, Files, Folder, FolderOpen, FolderSearch, GitBranch, Globe,
  GripVertical, House, Settings2, Star, Terminal, Trash2,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useLaunchProfilesStore, useProvidersStore, useSettingsStore, useSshMachinesStore, useWorkspacesStore } from "@/stores";
import AgentChatMenuItem from "./AgentChatMenuItem";
import WorkspaceSkillsMenuItem from "./WorkspaceSkillsMenuItem";
import { projectCliHooksService } from "@/services";
import { providerService } from "@/services/providerService";
import { isTauriRuntime } from "@/services/runtime";
import {
  detectAppPlatform,
  getWorkspaceDefaultEnvironment,
  getWorkspaceLaunchIssueKey,
  getWorkspaceLaunchIssueValues,
  hasWorkspaceWslPath,
  resolveCliEnvironmentDefault,
  resolveWorkspaceLaunchOptions,
} from "@/utils";
import type {
  LaunchProfile,
  LaunchProfileRuntime,
  OpenTerminalOptions,
  ProjectCliHookGroupStatus,
  ProjectCliHookStatus,
  Workspace, WorkspaceLaunchEnvironment,
} from "@/types";
import AddSshProjectDialog from "./AddSshProjectDialog";
import ArchiveMenuItem from "./ArchiveMenuItem";
import WorkspaceBadges from "./WorkspaceBadges";
import WorkspaceAppearanceMenu from "./WorkspaceAppearanceMenu";
import { sidebarEntityCountClass, sidebarEntityRowClass } from "./sidebarStyles";
import WorkspaceColorDot from "./WorkspaceColorDot";
import WorkspaceGroupDialog from "./WorkspaceGroupDialog";
import { normalizeWorkspaceProjects } from "./workspaceProjects";
import {
  buildSidebarCliLaunchItems,
  buildSidebarLaunchActions,
  filterSidebarFavoriteLaunchActions,
  getDefaultSidebarFavoriteLaunchActionIds,
  groupSidebarCliLaunchItems,
  normalizeSidebarFavoriteLaunchActionIds,
  type SidebarCliLaunchItem,
} from "./launchMenu";
interface WorkspaceItemProps {
  ws: Workspace;
  expanded: boolean;
  children: React.ReactNode;
  onExpand: (wsId: string) => void;
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
  onRename: (ws: Workspace) => void;
  onDelete: (ws: Workspace) => void;
  onSetAlias: (ws: Workspace) => void;
  onImportProject: (ws: Workspace) => void;
  onScanImport: (ws: Workspace) => void;
  onGitClone: (ws: Workspace) => void;
  onSetPath: (ws: Workspace) => void;
  onClearPath: (ws: Workspace) => void;
  onOpenEnvironment: (ws: Workspace) => void;
  onOpenInFileBrowser?: (path: string) => void;
  dragHandleProps?: ButtonHTMLAttributes<HTMLButtonElement>;
  countOverride?: number; // 头部计数徽章覆盖值（终端模式=终端数）
  availableCliToolIds?: ReadonlySet<string>;
}

export default function WorkspaceItem({
  ws,
  expanded,
  children,
  onExpand,
  onOpenTerminal,
  onRename,
  onDelete,
  onSetAlias,
  onImportProject,
  onScanImport,
  onGitClone,
  onSetPath,
  onClearPath,
  onOpenEnvironment, onOpenInFileBrowser,
  dragHandleProps, countOverride, availableCliToolIds,
}: WorkspaceItemProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const projects = normalizeWorkspaceProjects(ws.projects);
  const workspace = projects === ws.projects ? ws : { ...ws, projects };
  const providerList = useProvidersStore((s) => s.providers);
  const settings = useSettingsStore((s) => s.settings);
  const rawFavoriteLaunchIds = useSettingsStore((s) => s.settings?.general.launchFavorites);
  const favoriteLaunchIds = useMemo(() => normalizeSidebarFavoriteLaunchActionIds(
    rawFavoriteLaunchIds ?? getDefaultSidebarFavoriteLaunchActionIds(),
  ), [rawFavoriteLaunchIds]);
  const saveSettings = useSettingsStore((s) => s.saveSettings);
  const sshMachines = useSshMachinesStore((s) => s.machines);
  const launchProfiles = useLaunchProfilesStore((s) => s.profiles);
  const [hookGroups, setHookGroups] = useState<ProjectCliHookGroupStatus[]>([]);
  const [sshDialogOpen, setSshDialogOpen] = useState(false);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);

  const setArchived = useWorkspacesStore((state) => state.setArchived);
  const isDefaultWorkspace = !!workspace.isDefault;
  const isArchived = !!workspace.archivedAt;
  const displayName = workspace.alias
    || (isDefaultWorkspace ? t("defaultWorkspaceName", { defaultValue: "默认工作空间" }) : workspace.name);
  const rootProject = projects.find((project) => !project.ssh);
  const rootPath = workspace.path || rootProject?.path;
  const showWslBadge = hasWorkspaceWslPath(workspace);
  const defaultEnvironment = getWorkspaceDefaultEnvironment(workspace);
  const boundProvider = workspace.providerId
    ? providerList.find((provider) => provider.id === workspace.providerId)
    : undefined;
  const isWindows = detectAppPlatform() === "windows";
  const canLaunchWsl = isWindows
    && !resolveWorkspaceLaunchOptions({
      workspace,
      machines: sshMachines,
      environment: "wsl",
    }).issue;
  const canLaunchSsh = !resolveWorkspaceLaunchOptions({
    workspace,
    machines: sshMachines,
    environment: "ssh",
  }).issue;
  const cliLaunchItems = buildSidebarCliLaunchItems(t, canLaunchWsl, canLaunchSsh, availableCliToolIds);
  const nonFavoriteCliLaunchItems = groupSidebarCliLaunchItems(cliLaunchItems, favoriteLaunchIds).more;
  const favoriteLaunchActions = filterSidebarFavoriteLaunchActions(
    buildSidebarLaunchActions(t, canLaunchWsl, canLaunchSsh, availableCliToolIds),
    favoriteLaunchIds,
  );
  const allLaunchActions = buildSidebarLaunchActions(t, canLaunchWsl, canLaunchSsh, availableCliToolIds);
  const hideNonFavoriteLaunchActions = settings?.general.hideNonFavoriteLaunchActions ?? false;
  const shouldHideNonFavoriteLaunchActions = hideNonFavoriteLaunchActions && favoriteLaunchActions.length > 0;
  const formatLaunchIssue = useCallback((
    issue: NonNullable<ReturnType<typeof resolveWorkspaceLaunchOptions>["issue"]>,
  ) => {
    return t(getWorkspaceLaunchIssueKey(issue), {
      ...getWorkspaceLaunchIssueValues(issue),
      defaultValue: {
        local_path_missing: "Local launch requires a workspace path or a local project.",
        path_platform_mismatch: "The saved path belongs to another operating system: {{path}}",
        wsl_unsupported: "WSL is only available on Windows.",
        wsl_path_missing: "WSL launch requires a remote path.",
        wsl_local_path_missing: "WSL launch requires a local anchor path or a WSL project.",
        ssh_machine_missing: "SSH launch requires a selected machine.",
        ssh_machine_not_found: "The saved SSH machine could not be found: {{machineId}}",
        ssh_path_missing: "SSH launch requires a remote path.",
      }[issue.code],
    });
  }, [t]);

  const openWorkspace = useCallback((
    cliTool?: OpenTerminalOptions["cliTool"],
    environment?: WorkspaceLaunchEnvironment,
    launchProfileId?: string,
  ) => {
    const { options, issue } = resolveWorkspaceLaunchOptions({
      workspace,
      cliTool,
      launchProfileId,
      machines: sshMachines,
      environment,
    });
    if (!options || issue) {
      const fallbackEnvironment =
        environment
        ?? resolveCliEnvironmentDefault(workspace, cliTool)
        ?? getWorkspaceDefaultEnvironment(workspace);
      toast.error(
        formatLaunchIssue(issue ?? {
          environment: fallbackEnvironment,
          code: "local_path_missing",
        }),
      );
      return;
    }
    onOpenTerminal(options);
  }, [formatLaunchIssue, onOpenTerminal, sshMachines, workspace]);

  const profileDisplayName = useCallback((profile: Pick<LaunchProfile, "name" | "alias">) => {
    return profile.alias || profile.name;
  }, []);

  const profileMatchesCli = useCallback((profile: LaunchProfile, cliTool: NonNullable<OpenTerminalOptions["cliTool"]>) => {
    return profile.targetTools.length === 0 || profile.targetTools.includes(cliTool);
  }, []);

  const profileMatchesRuntime = useCallback((profile: LaunchProfile, environment: WorkspaceLaunchEnvironment) => {
    return !profile.targetRuntime || profile.targetRuntime === environment;
  }, []);

  const runtimeLabel = useCallback((runtime?: LaunchProfileRuntime) => {
    if (runtime === "wsl") return "WSL";
    if (runtime === "ssh") return "SSH";
    if (runtime === "local") return t("launchProfileRuntimeLocal", { defaultValue: "本机" });
    return t("launchProfileRuntimeAll", { defaultValue: "全部位置" });
  }, [t]);

  const renderCliLaunchMenuItem = useCallback((item: SidebarCliLaunchItem, keyPrefix: string) => {
    const effectiveEnvironment =
      item.environment
      ?? resolveCliEnvironmentDefault(workspace, item.cliTool)
      ?? defaultEnvironment;
    const boundProfile = workspace.launchProfileId
      ? launchProfiles.find((profile) => profile.id === workspace.launchProfileId)
      : undefined;
    const boundProfileName = workspace.launchProfileId
      ? profileDisplayName(boundProfile ?? { name: workspace.launchProfileId, alias: null })
      : t("launchProfileUnbound", { defaultValue: "未绑定" });
    const boundProfileMatchesTarget = boundProfile
      ? profileMatchesCli(boundProfile, item.cliTool) && profileMatchesRuntime(boundProfile, effectiveEnvironment)
      : false;
    const boundProfileStatusLabel = boundProfileMatchesTarget
      ? boundProfileName
      : `${boundProfileName} (${t("launchProfileBindingMismatch", { defaultValue: "不适用于当前入口" })})`;
    const selectableProfiles = launchProfiles
      .filter((profile) => profileMatchesCli(profile, item.cliTool))
      .filter((profile) => profileMatchesRuntime(profile, effectiveEnvironment));
    const incompatibleRuntimeProfileCount = launchProfiles
      .filter((profile) => profileMatchesCli(profile, item.cliTool))
      .filter((profile) => !profileMatchesRuntime(profile, effectiveEnvironment)).length;
    const defaultActionLabel = workspace.launchProfileId && boundProfileMatchesTarget
      ? t("launchProfileUseWorkspaceBinding", {
        profile: boundProfileName,
        defaultValue: `使用工作空间绑定：${boundProfileName}`,
      })
      : workspace.launchProfileId
        ? t("launchProfileUseDefaultBindingMismatch", {
          profile: boundProfileName,
          runtime: runtimeLabel(effectiveEnvironment),
          defaultValue: `使用默认运行配置（${boundProfileName} 不适用于 ${runtimeLabel(effectiveEnvironment)}）`,
        })
        : t("launchProfileUseDefault", { defaultValue: "使用默认运行配置" });

    return (
      <ContextMenuSub key={`${keyPrefix}-${item.key}`}>
        <ContextMenuSubTrigger onClick={() => openWorkspace(item.cliTool, item.environment)}>
          <Terminal /> {item.label}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-80">
          <ContextMenuItem disabled>
            {t("launchProfileWorkspaceBinding", {
              profile: boundProfileStatusLabel,
              defaultValue: `工作空间绑定：${boundProfileStatusLabel}`,
            })}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => openWorkspace(item.cliTool, item.environment)}>
            <Terminal /> {defaultActionLabel}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled>
            {t("launchProfileChoose", { defaultValue: "指定运行配置" })}
          </ContextMenuItem>
          {selectableProfiles.length > 0 ? (
            selectableProfiles.map((profile) => (
              <ContextMenuItem
                key={profile.id}
                onClick={() => openWorkspace(item.cliTool, item.environment, profile.id)}
              >
                <Terminal /> {profileDisplayName(profile)}
                <span className="ml-auto text-[11px] opacity-70">
                  {profile.id === workspace.launchProfileId
                    ? t("launchProfileBoundBadge", { defaultValue: "已绑定" })
                    : runtimeLabel(profile.targetRuntime ?? null)}
                </span>
              </ContextMenuItem>
            ))
          ) : (
            <ContextMenuItem disabled>
              {t("launchProfileEmptyForCli", { defaultValue: "当前 CLI 暂无其他运行配置" })}
            </ContextMenuItem>
          )}
          {incompatibleRuntimeProfileCount > 0 ? (
            <ContextMenuItem disabled>
              {t("launchProfileHiddenByRuntime", {
                count: incompatibleRuntimeProfileCount,
                runtime: runtimeLabel(effectiveEnvironment),
                defaultValue: `${incompatibleRuntimeProfileCount} 个配置不适用于 ${runtimeLabel(effectiveEnvironment)}`,
              })}
            </ContextMenuItem>
          ) : null}
        </ContextMenuSubContent>
      </ContextMenuSub>
    );
  }, [defaultEnvironment, launchProfiles, openWorkspace, profileDisplayName, profileMatchesCli, profileMatchesRuntime, runtimeLabel, t, workspace]);

  const fetchHookStatuses = useCallback(async () => {
    if (!rootPath) return;
    try {
      const statuses = await projectCliHooksService.getStatus(rootPath);
      setHookGroups(statuses);
    } catch {
      setHookGroups([]);
    }
  }, [rootPath]);

  const handleToggleHook = useCallback(async (cliTool: string, hook: ProjectCliHookStatus) => {
    if (!rootPath) return;
    try {
      await projectCliHooksService.setHookEnabled(rootPath, cliTool, hook.name, !hook.enabled);
      await fetchHookStatuses();
    } catch (error) {
      toast.error(t("hookOperationFailed", { error }));
    }
  }, [fetchHookStatuses, rootPath, t]);

  const handleRevealFolder = useCallback(async () => {
    if (!rootPath) return;
    if (!isTauriRuntime()) {
      await navigator.clipboard.writeText(rootPath).catch(() => {});
      toast.info(t("filetree.pathCopied", { defaultValue: "Path copied" }));
      return;
    }
    try {
      await providerService.openPathInExplorer(rootPath);
    } catch (error) {
      toast.error(t("openFolderFailed", { error }));
    }
  }, [rootPath, t]);

  const handleToggleHideNonFavoriteLaunchActions = useCallback(async (checked: boolean) => {
    if (!settings) return;
    try {
      await saveSettings({
        ...settings,
        general: {
          ...settings.general,
          hideNonFavoriteLaunchActions: checked,
        },
      });
    } catch (error) {
      toast.error(t("operationFailed", { ns: "settings", error: String(error) }));
    }
  }, [saveSettings, settings, t]);

  const handleToggleFavoriteLaunchAction = useCallback(async (actionId: string, checked: boolean) => {
    if (!settings) return;
    const nextFavorites = checked
      ? [...favoriteLaunchIds, actionId]
      : favoriteLaunchIds.filter((id) => id !== actionId);

    try {
      await saveSettings({
        ...settings,
        general: {
          ...settings.general,
          launchFavorites: nextFavorites,
        },
      });
    } catch (error) {
      toast.error(t("operationFailed", { ns: "settings", error: String(error) }));
    }
  }, [favoriteLaunchIds, saveSettings, settings, t]);

  function getHookLabel(hook: Pick<ProjectCliHookStatus, "name" | "label">): string {
    const labels: Record<string, string> = {
      "session-inject": t("hookSessionInject"),
      "plan-archive": t("hookPlanArchive"),
    };
    return labels[hook.name] || hook.label;
  }

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            aria-expanded={expanded}
            className={`${sidebarEntityRowClass} flex items-center justify-between gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] ${
              expanded
                ? "bg-[var(--app-active-bg)] text-[var(--app-accent)]"
                : isDefaultWorkspace
                  ? "text-[var(--app-text-primary)] bg-[color-mix(in_srgb,var(--app-accent)_5%,transparent)] hover:bg-[color-mix(in_srgb,var(--app-accent)_10%,transparent)]"
                  : "text-[var(--app-text-primary)] hover:bg-[var(--app-hover)]"
            }`}
            onClick={() => onExpand(workspace.id)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onExpand(workspace.id);
              }
            }}
          >
            {expanded ? (
              <span
                aria-hidden="true"
                className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full bg-[var(--app-accent)]"
              />
            ) : null}
            <div className="flex min-w-0 items-center gap-1.5">
              {dragHandleProps ? (
                <button
                  type="button"
                  aria-label={t("workspaceReorderHandle", {
                    defaultValue: "拖动排序工作空间",
                  })}
                  className="flex h-4 w-3 -ml-1 shrink-0 items-center justify-center rounded text-[var(--app-text-tertiary)] opacity-0 transition-opacity duration-[var(--dur-fast)] cursor-grab group-hover:opacity-50 hover:!opacity-90 hover:text-[var(--app-text-secondary)] active:cursor-grabbing"
                  onClick={(event) => event.stopPropagation()}
                  {...dragHandleProps}
                >
                  <GripVertical className="h-3 w-3" />
                </button>
              ) : <span aria-hidden="true" className="h-4 w-3 -ml-1 shrink-0" />}
              <ChevronRight
                className={`w-3.5 h-3.5 shrink-0 transition-transform ${expanded ? "rotate-90 text-[var(--app-accent)]" : "text-[var(--app-text-tertiary)]"}`}
              />
              {isDefaultWorkspace ? (
                <House className="w-4 h-4 shrink-0 text-[var(--app-accent)]" strokeWidth={1.5} />
              ) : expanded ? (
                <FolderOpen className="w-4 h-4 shrink-0 text-[var(--app-accent)]" />
              ) : (
                <Folder className="w-4 h-4 shrink-0 text-[var(--app-text-tertiary)] group-hover:text-[var(--app-text-secondary)] transition-colors" />
              )}
              {workspace.color ? <WorkspaceColorDot color={workspace.color} /> : null}
              <span className="truncate text-[13px] font-medium">{displayName}</span>
              <WorkspaceBadges
                isDefault={isDefaultWorkspace}
                showWsl={showWslBadge}
                isArchived={isArchived}
                providerName={
                  boundProvider && defaultEnvironment !== "wsl"
                    ? boundProvider.name
                    : undefined
                }
              />
            </div>
            <span
              className={sidebarEntityCountClass}
              style={{ background: "color-mix(in srgb, var(--app-text-primary) 8%, transparent)" }}
            >
              {countOverride ?? projects.length}
            </span>
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent className="w-56">
          <ContextMenuItem disabled>
            <Star /> {t("favoriteLaunches", { defaultValue: "常用" })}
          </ContextMenuItem>
          {favoriteLaunchActions.length > 0 ? (
            favoriteLaunchActions.map((action) => {
              if (action.kind === "cli" && action.cliTool) {
                return renderCliLaunchMenuItem({
                  key: action.id,
                  cliTool: action.cliTool,
                  environment: action.environment,
                  label: action.label,
                }, "favorite");
              }
              return (
                <ContextMenuItem
                  key={`favorite-${action.id}`}
                  onClick={() => openWorkspace(action.cliTool, action.environment)}
                >
                  <Terminal /> {action.label}
                </ContextMenuItem>
              );
            })
          ) : (
            <ContextMenuItem disabled>
              {t("favoriteLaunchEmpty", { defaultValue: "暂无常用项" })}
            </ContextMenuItem>
          )}

          <ContextMenuSeparator />

          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Star /> {t("favoriteLaunchManage", { defaultValue: "显示在常用" })}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-60">
              {allLaunchActions.map((action) => (
                <ContextMenuCheckboxItem
                  key={`favorite-toggle-${action.id}`}
                  checked={favoriteLaunchIds.includes(action.id)}
                  onCheckedChange={(checked) => void handleToggleFavoriteLaunchAction(action.id, checked === true)}
                >
                  {t("favoriteLaunchToggleLabel", {
                    label: action.label,
                    defaultValue: `显示 ${action.label}`,
                  })}
                </ContextMenuCheckboxItem>
              ))}
              <ContextMenuSeparator />
              <ContextMenuCheckboxItem
                checked={hideNonFavoriteLaunchActions}
                onCheckedChange={(checked) => void handleToggleHideNonFavoriteLaunchActions(checked === true)}
              >
                {t("hideNonFavoriteLaunchActions", { defaultValue: "隐藏非常用菜单" })}
              </ContextMenuCheckboxItem>
            </ContextMenuSubContent>
          </ContextMenuSub>

          <ContextMenuSeparator />
          <AgentChatMenuItem path={rootPath} />
          {!shouldHideNonFavoriteLaunchActions ? (
            <>
              <ContextMenuItem onClick={() => openWorkspace()}>
                <Terminal /> {t("openTerminal")}
              </ContextMenuItem>

              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <Terminal /> {t("workspaceEnv.launchThisTime", { defaultValue: "本次选择环境" })}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="w-48">
                  <ContextMenuItem onClick={() => openWorkspace(undefined, "local")}>
                    <Terminal /> {t("workspaceEnv.local", { defaultValue: "本机" })}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => openWorkspace(undefined, "wsl")}>
                    <Terminal /> {t("workspaceEnv.wsl", { defaultValue: "WSL" })}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => openWorkspace(undefined, "ssh")}>
                    <Terminal /> {t("workspaceEnv.ssh", { defaultValue: "SSH" })}
                  </ContextMenuItem>
                </ContextMenuSubContent>
              </ContextMenuSub>

              {/* issue #36：非常用 CLI 项折叠进"更多启动方式"，顶层不再平铺 20+ 项；
                  常用项已在上方"常用"区展示，这里只放补集避免重复 */}
              {nonFavoriteCliLaunchItems.length > 0 && (
                <ContextMenuSub>
                  <ContextMenuSubTrigger>
                    <Terminal /> {t("moreLaunchActions", { defaultValue: "更多启动方式" })}
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent className="w-60">
                    {nonFavoriteCliLaunchItems.map((item) => renderCliLaunchMenuItem(item, "launch"))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
              )}

              <ContextMenuSeparator />
            </>
          ) : null}

          <ContextMenuItem onClick={() => onOpenEnvironment(workspace)}>
            <Settings2 /> {t("workspaceEnv.edit", { defaultValue: "编辑运行环境" })}
          </ContextMenuItem>
          <WorkspaceSkillsMenuItem workspace={workspace} />

          <ContextMenuSeparator />

          <ContextMenuItem disabled={!rootPath} onClick={handleRevealFolder}>
            <FolderOpen /> {t("openFolder")}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!rootPath}
            onClick={() => rootPath && onOpenInFileBrowser?.(rootPath)}
          >
            <Files /> {t("openInFileBrowser")}
          </ContextMenuItem>

          <ContextMenuSeparator />

          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Folder /> {t("importProject")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onClick={() => onImportProject(workspace)}>
                {t("importFromDir")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onScanImport(workspace)}>
                <FolderSearch /> {t("scanImportDirectory")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onGitClone(workspace)}>
                <GitBranch /> {t("cloneFromGit")}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => setSshDialogOpen(true)}>
                <Globe /> {t("addSshProject")}
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>

          <ContextMenuSeparator />

          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Settings2 /> {t("settings", { ns: "common" })}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-52">
              <ContextMenuItem onClick={() => onSetPath(workspace)}>
                {t("setWorkspacePath")}
              </ContextMenuItem>
              {workspace.path ? (
                <ContextMenuItem onClick={() => onClearPath(workspace)}>
                  {t("clearWorkspacePath")}
                </ContextMenuItem>
              ) : null}

              <ContextMenuSeparator />

              <ContextMenuItem onClick={() => onSetAlias(workspace)}>
                {t("setAlias")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onRename(workspace)}>
                {t("renameWorkspace")}
              </ContextMenuItem>

              <ContextMenuSeparator />

              <ContextMenuSub>
                <ContextMenuSubTrigger onPointerEnter={() => fetchHookStatuses()}>
                  {t("hooks")}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="w-52">
                  {hookGroups.map((group) => (
                    <ContextMenuSub key={group.cliTool}>
                      <ContextMenuSubTrigger>{group.label}</ContextMenuSubTrigger>
                      <ContextMenuSubContent className="w-56">
                        {group.hooks.map((hook) => (
                          <ContextMenuCheckboxItem
                            key={hook.name}
                            checked={hook.enabled}
                            disabled={!hook.supported}
                            onClick={() => hook.supported && handleToggleHook(group.cliTool, hook)}
                          >
                            {hook.supported
                              ? getHookLabel(hook)
                              : `${getHookLabel(hook)} (${t("hookUnavailable")})`}
                          </ContextMenuCheckboxItem>
                        ))}
                        {group.reason ? (
                          <ContextMenuItem disabled>
                            {t("hookUnavailableReason", { reason: group.reason })}
                          </ContextMenuItem>
                        ) : null}
                      </ContextMenuSubContent>
                    </ContextMenuSub>
                  ))}
                  {hookGroups.length === 0 ? (
                    <ContextMenuItem disabled>Loading...</ContextMenuItem>
                  ) : null}
                </ContextMenuSubContent>
              </ContextMenuSub>
            </ContextMenuSubContent>
          </ContextMenuSub>

          {!isDefaultWorkspace ? (
            <>
              <ContextMenuSeparator />
              <WorkspaceAppearanceMenu
                workspace={workspace}
                onNewGroup={() => setGroupDialogOpen(true)}
              />
              <ContextMenuSeparator />
              <ArchiveMenuItem
                target="workspace"
                archivedAt={workspace.archivedAt}
                onToggle={(next) => void setArchived(workspace.name, next)}
              />
              <ContextMenuItem variant="destructive" onClick={() => onDelete(workspace)}>
                <Trash2 /> {t("deleteWorkspace")}
              </ContextMenuItem>
            </>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>

      {expanded ? (
        <div className="mb-1 ml-[22px] border-l border-[var(--app-border)] pl-3">
          {children}
        </div>
      ) : null}

      <AddSshProjectDialog
        open={sshDialogOpen}
        onOpenChange={setSshDialogOpen}
        workspaceName={workspace.name}
      />
      <WorkspaceGroupDialog
        workspace={workspace}
        open={groupDialogOpen}
        onOpenChange={setGroupDialogOpen}
      />
    </div>
  );
}
