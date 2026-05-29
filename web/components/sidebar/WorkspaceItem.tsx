import { useCallback, useState, type ButtonHTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import { openPath } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import {
  ChevronRight,
  Files,
  Folder,
  FolderOpen,
  FolderSearch,
  GitBranch,
  Globe,
  GripVertical,
  Settings2,
  Star,
  Terminal,
  Trash2,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLaunchProfilesStore, useProvidersStore, useSettingsStore, useSshMachinesStore } from "@/stores";
import { projectCliHooksService } from "@/services";
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
  Workspace,
  WorkspaceLaunchEnvironment,
} from "@/types";
import AddSshProjectDialog from "./AddSshProjectDialog";
import {
  buildSidebarCliLaunchItems,
  buildSidebarLaunchActions,
  filterSidebarFavoriteLaunchActions,
  getDefaultSidebarFavoriteLaunchActionIds,
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
  onOpenEnvironment,
  onOpenInFileBrowser,
  dragHandleProps,
}: WorkspaceItemProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const providerList = useProvidersStore((s) => s.providers);
  const settings = useSettingsStore((s) => s.settings);
  const favoriteLaunchIds = useSettingsStore((s) => normalizeSidebarFavoriteLaunchActionIds(
    s.settings?.general.launchFavorites ?? getDefaultSidebarFavoriteLaunchActionIds(),
  ));
  const saveSettings = useSettingsStore((s) => s.saveSettings);
  const sshMachines = useSshMachinesStore((s) => s.machines);
  const launchProfiles = useLaunchProfilesStore((s) => s.profiles);
  const [hookGroups, setHookGroups] = useState<ProjectCliHookGroupStatus[]>([]);
  const [sshDialogOpen, setSshDialogOpen] = useState(false);

  const displayName = ws.alias || ws.name;
  const rootProject = ws.projects.find((project) => !project.ssh);
  const rootPath = ws.path || rootProject?.path;
  const showWslBadge = hasWorkspaceWslPath(ws);
  const defaultEnvironment = getWorkspaceDefaultEnvironment(ws);
  const boundProvider = ws.providerId
    ? providerList.find((provider) => provider.id === ws.providerId)
    : undefined;
  const isWindows = detectAppPlatform() === "windows";
  const canLaunchWsl = isWindows
    && !resolveWorkspaceLaunchOptions({
      workspace: ws,
      machines: sshMachines,
      environment: "wsl",
    }).issue;
  const canLaunchSsh = !resolveWorkspaceLaunchOptions({
    workspace: ws,
    machines: sshMachines,
    environment: "ssh",
  }).issue;
  const cliLaunchItems = buildSidebarCliLaunchItems(t, canLaunchWsl, canLaunchSsh);
  const favoriteLaunchActions = filterSidebarFavoriteLaunchActions(
    buildSidebarLaunchActions(t, canLaunchWsl, canLaunchSsh),
    favoriteLaunchIds,
  );
  const allLaunchActions = buildSidebarLaunchActions(t, canLaunchWsl, canLaunchSsh);
  const hideNonFavoriteLaunchActions = settings?.general.hideNonFavoriteLaunchActions ?? false;
  const shouldHideNonFavoriteLaunchActions = hideNonFavoriteLaunchActions && favoriteLaunchActions.length > 0;
  const formatLaunchIssue = useCallback((
    issue: NonNullable<ReturnType<typeof resolveWorkspaceLaunchOptions>["issue"]>,
  ) => {
    return t(getWorkspaceLaunchIssueKey(issue), {
      ...getWorkspaceLaunchIssueValues(issue),
      defaultValue: {
        local_path_missing: "Local launch requires a workspace path or a local project.",
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
      workspace: ws,
      cliTool,
      launchProfileId,
      machines: sshMachines,
      environment,
    });
    if (!options || issue) {
      const fallbackEnvironment =
        environment
        ?? resolveCliEnvironmentDefault(ws, cliTool)
        ?? getWorkspaceDefaultEnvironment(ws);
      toast.error(
        formatLaunchIssue(issue ?? {
          environment: fallbackEnvironment,
          code: "local_path_missing",
        }),
      );
      return;
    }
    onOpenTerminal(options);
  }, [formatLaunchIssue, onOpenTerminal, sshMachines, ws]);

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
      ?? resolveCliEnvironmentDefault(ws, item.cliTool)
      ?? defaultEnvironment;
    const boundProfile = ws.launchProfileId
      ? launchProfiles.find((profile) => profile.id === ws.launchProfileId)
      : undefined;
    const boundProfileName = ws.launchProfileId
      ? profileDisplayName(boundProfile ?? { name: ws.launchProfileId, alias: null })
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
    const defaultActionLabel = ws.launchProfileId && boundProfileMatchesTarget
      ? t("launchProfileUseWorkspaceBinding", {
        profile: boundProfileName,
        defaultValue: `使用工作空间绑定：${boundProfileName}`,
      })
      : ws.launchProfileId
        ? t("launchProfileUseDefaultBindingMismatch", {
          profile: boundProfileName,
          runtime: runtimeLabel(effectiveEnvironment),
          defaultValue: `使用默认运行配置（${boundProfileName} 不适用于 ${runtimeLabel(effectiveEnvironment)}）`,
        })
        : t("launchProfileUseDefault", { defaultValue: "使用默认运行配置" });

    return (
      <ContextMenuSub key={`${keyPrefix}-${item.key}`}>
        <ContextMenuSubTrigger>
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
                  {profile.id === ws.launchProfileId
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
  }, [defaultEnvironment, launchProfiles, openWorkspace, profileDisplayName, profileMatchesCli, profileMatchesRuntime, runtimeLabel, t, ws]);

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
    try {
      await openPath(rootPath);
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
            className={`w-full group flex items-center justify-between px-3 py-1.5 rounded-lg transition-colors duration-150 ${
              expanded
                ? "border border-[var(--app-border)] text-[var(--app-accent)]"
                : "border border-transparent text-[var(--app-text-primary)] hover:bg-[var(--app-hover)]"
            }`}
            style={expanded ? { background: "var(--app-hover)" } : undefined}
            onClick={() => onExpand(ws.id)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onExpand(ws.id);
              }
            }}
          >
            <div className="flex items-center gap-1.5">
              {dragHandleProps ? (
                <button
                  type="button"
                  aria-label={t("workspaceReorderHandle", {
                    defaultValue: "拖动排序工作空间",
                  })}
                  className="flex h-4 w-3 -ml-1 items-center justify-center rounded text-[var(--app-text-tertiary)] opacity-0 transition-opacity duration-150 cursor-grab group-hover:opacity-50 hover:!opacity-90 hover:text-[var(--app-text-secondary)] active:cursor-grabbing"
                  onClick={(event) => event.stopPropagation()}
                  {...dragHandleProps}
                >
                  <GripVertical className="h-3 w-3" />
                </button>
              ) : null}
              <ChevronRight className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} />
              <span className="text-sm font-medium tracking-wide">{displayName}</span>
              {showWslBadge ? (
                <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700 border border-amber-200 dark:bg-amber-500/20 dark:text-amber-300 dark:border-amber-500/30">
                  WSL
                </span>
              ) : null}
              {boundProvider && defaultEnvironment !== "wsl" ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium border bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-500/20 dark:text-slate-300 dark:border-slate-500/30">
                      {boundProvider.name}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">Provider: {boundProvider.name}</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
            <span
              className="text-[11px] font-medium tabular-nums leading-none min-w-[22px] text-center px-2 py-1 rounded-full text-[var(--app-text-tertiary)] group-hover:text-[var(--app-text-secondary)] transition-colors"
              style={{ background: "color-mix(in srgb, var(--app-text-primary) 8%, transparent)" }}
            >
              {ws.projects.length}
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

              {cliLaunchItems.map((item) => renderCliLaunchMenuItem(item, "launch"))}

              <ContextMenuSeparator />
            </>
          ) : null}

          <ContextMenuItem onClick={() => onOpenEnvironment(ws)}>
            <Settings2 /> {t("workspaceEnv.edit", { defaultValue: "编辑运行环境" })}
          </ContextMenuItem>

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
              <ContextMenuItem onClick={() => onImportProject(ws)}>
                {t("importFromDir")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onScanImport(ws)}>
                <FolderSearch /> {t("scanImportDirectory")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onGitClone(ws)}>
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
              <ContextMenuItem onClick={() => onSetPath(ws)}>
                {t("setWorkspacePath")}
              </ContextMenuItem>
              {ws.path ? (
                <ContextMenuItem onClick={() => onClearPath(ws)}>
                  {t("clearWorkspacePath")}
                </ContextMenuItem>
              ) : null}

              <ContextMenuSeparator />

              <ContextMenuItem onClick={() => onSetAlias(ws)}>
                {t("setAlias")}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onRename(ws)}>
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

          <ContextMenuSeparator />

          <ContextMenuItem variant="destructive" onClick={() => onDelete(ws)}>
            <Trash2 /> {t("deleteWorkspace")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {expanded ? (
        <div className="mx-3 mb-2 overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-glass-bg)]">
          {children}
        </div>
      ) : null}

      <AddSshProjectDialog
        open={sshDialogOpen}
        onOpenChange={setSshDialogOpen}
        workspaceName={ws.name}
      />
    </div>
  );
}
