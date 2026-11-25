import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/toast";
import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import {
  Bot, ChevronRight, Folder, FolderOpen, FolderSearch, GitBranch, Globe,
  House, Rocket, Star, Terminal,
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
import {
  useLaunchProfilesStore, useProvidersStore, useSettingsStore, useSshMachinesStore,
} from "@/stores";
import AgentChatMenuItem from "./AgentChatMenuItem";
import InjectionBadges from "./InjectionBadges";
import { summarizeInjection } from "./launchInjectionSummary";
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
  OpenTerminalOptions,
  Workspace, WorkspaceLaunchEnvironment,
} from "@/types";
import AddSshProjectDialog from "./AddSshProjectDialog";
import WorkspaceBadges from "./WorkspaceBadges";
import WorkspaceHoverCard from "./WorkspaceHoverCard";
import WorkspaceManageMenu from "./WorkspaceManageMenu";
import WorkspaceDangerItems from "./WorkspaceDangerItems";
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
  /** dnd-kit 的行级监听（长按整行拖动排序）；系统工作空间不传 */
  dragListeners?: DraggableSyntheticListeners;
  isDragging?: boolean;
  countOverride?: number; // 头部计数覆盖值（终端模式=终端数）
  /** 弱化显示（终端模式下无运行终端的工作空间），让有活动的工作空间更突出 */
  dimmed?: boolean;
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
  dragListeners, isDragging = false, countOverride, availableCliToolIds, dimmed = false,
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
  const [sshDialogOpen, setSshDialogOpen] = useState(false);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);

  const isDefaultWorkspace = !!workspace.isDefault;
  const isAgentChatWorkspace = !!workspace.isAgentChat;
  const isArchived = !!workspace.archivedAt;
  const systemName = isDefaultWorkspace
    ? t("defaultWorkspaceName", { defaultValue: "默认工作空间" })
    : isAgentChatWorkspace ? t("agentChatWorkspaceName", { defaultValue: "Agent Chat" }) : null;
  const displayName = workspace.alias || systemName || workspace.name;
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
      ? profileMatchesCli(boundProfile, item.cliTool)
      : false;
    const boundProfileStatusLabel = boundProfileMatchesTarget
      ? boundProfileName
      : `${boundProfileName} (${t("launchProfileBindingMismatch", { defaultValue: "不适用于当前入口" })})`;
    // 运行配置本机 / WSL / SSH 通用：只按 CLI 过滤，不再按运行位置隐藏
    const selectableProfiles = launchProfiles
      .filter((profile) => profileMatchesCli(profile, item.cliTool));
    const defaultActionLabel = workspace.launchProfileId && boundProfileMatchesTarget
      ? t("launchProfileUseWorkspaceBinding", {
        profile: boundProfileName,
        defaultValue: `使用工作空间绑定：${boundProfileName}`,
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
            <Terminal />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate">{defaultActionLabel}</span>
              <InjectionBadges
                summary={summarizeInjection(
                  boundProfileMatchesTarget ? boundProfile ?? null : null,
                  effectiveEnvironment,
                  item.cliTool,
                )}
              />
            </span>
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
                <Terminal />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate">{profileDisplayName(profile)}</span>
                  <InjectionBadges summary={summarizeInjection(profile, effectiveEnvironment, item.cliTool)} />
                </span>
                {profile.id === workspace.launchProfileId ? (
                  <span className="ml-auto shrink-0 self-start text-[length:var(--text-caption)] opacity-70">
                    {t("launchProfileBoundBadge", { defaultValue: "已绑定" })}
                  </span>
                ) : null}
              </ContextMenuItem>
            ))
          ) : (
            <ContextMenuItem disabled>
              {t("launchProfileEmptyForCli", { defaultValue: "当前 CLI 暂无其他运行配置" })}
            </ContextMenuItem>
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
    );
  }, [defaultEnvironment, launchProfiles, openWorkspace, profileDisplayName, profileMatchesCli, t, workspace]);

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

  return (
    <div>
      <ContextMenu>
        <WorkspaceHoverCard workspace={workspace} disabled={isDefaultWorkspace || isAgentChatWorkspace || isDragging}>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            data-typeahead-label={workspace.alias || workspace.name}
            aria-expanded={expanded}
            className={`${sidebarEntityRowClass} flex items-center justify-between gap-2 hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] ${
              dimmed ? "text-[var(--app-text-tertiary)] hover:text-[var(--app-text-secondary)]" : "text-[var(--app-text-primary)]"
            } ${isDragging ? "cursor-grabbing bg-[var(--app-hover)]" : ""}`}
            {...dragListeners}
            onClick={() => onExpand(workspace.id)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onExpand(workspace.id);
              }
            }}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <ChevronRight
                className={`w-3.5 h-3.5 shrink-0 transition-transform text-[var(--app-text-tertiary)] ${expanded ? "rotate-90" : ""}`}
              />
              {isDefaultWorkspace ? (
                <House className="w-4 h-4 shrink-0 text-[var(--app-text-secondary)]" strokeWidth={1.5} />
              ) : isAgentChatWorkspace ? (
                <Bot className="w-4 h-4 shrink-0 text-[var(--app-text-secondary)]" strokeWidth={1.5} />
              ) : expanded ? (
                <FolderOpen className="w-4 h-4 shrink-0 text-[var(--app-text-secondary)]" />
              ) : (
                <Folder className="w-4 h-4 shrink-0 text-[var(--app-text-tertiary)] group-hover:text-[var(--app-text-secondary)] transition-colors" />
              )}
              {workspace.color ? <WorkspaceColorDot color={workspace.color} /> : null}
              <span className="truncate text-[length:var(--text-row)] font-medium">{displayName}</span>
              <WorkspaceBadges
                showWsl={showWslBadge}
                isArchived={isArchived}
                providerName={
                  boundProvider && defaultEnvironment !== "wsl"
                    ? boundProvider.name
                    : undefined
                }
              />
            </div>
            {/* 计数为 0 不渲染，避免一列「0」的噪音 */}
            {(countOverride ?? projects.length) > 0 ? (
              <span className={sidebarEntityCountClass}>{countOverride ?? projects.length}</span>
            ) : null}
          </div>
        </ContextMenuTrigger>
        </WorkspaceHoverCard>

        <ContextMenuContent className="w-56">
          {/* 启动：常用项直接列（没设常用时退回「打开终端」），其余都收进「其他启动方式」 */}
          {favoriteLaunchActions.length > 0 ? favoriteLaunchActions.map((action) =>
            action.kind === "cli" && action.cliTool
              ? renderCliLaunchMenuItem({ key: action.id, cliTool: action.cliTool, environment: action.environment, label: action.label }, "favorite")
              : (
                <ContextMenuItem key={`favorite-${action.id}`} onClick={() => openWorkspace(action.cliTool, action.environment)}>
                  <Terminal /> {action.label}
                </ContextMenuItem>
              )) : (
            <ContextMenuItem onClick={() => openWorkspace()}>
              <Terminal /> {t("openTerminal")}
            </ContextMenuItem>
          )}
          <AgentChatMenuItem path={rootPath} />
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Rocket /> {t("moreLaunchActions", { defaultValue: "更多启动方式" })}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-60">
              {!shouldHideNonFavoriteLaunchActions ? (
                <>
                  {favoriteLaunchActions.length > 0 ? (
                    <ContextMenuItem onClick={() => openWorkspace()}>
                      <Terminal /> {t("openTerminal")}
                    </ContextMenuItem>
                  ) : null}
                  {(["local", "wsl", "ssh"] as const).map((environment) => (
                    <ContextMenuItem key={environment} onClick={() => openWorkspace(undefined, environment)}>
                      <Terminal /> {t("workspaceMenu.openTerminalIn", { env: t(`workspaceEnv.${environment}`) })}
                    </ContextMenuItem>
                  ))}
                  {nonFavoriteCliLaunchItems.length > 0 ? <ContextMenuSeparator /> : null}
                  {nonFavoriteCliLaunchItems.map((item) => renderCliLaunchMenuItem(item, "launch"))}
                  <ContextMenuSeparator />
                </>
              ) : null}
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
                      {action.label}
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
            </ContextMenuSubContent>
          </ContextMenuSub>

          <ContextMenuSeparator />
          <WorkspaceManageMenu
            workspace={workspace}
            rootPath={rootPath}
            isSystem={isDefaultWorkspace || isAgentChatWorkspace}
            onOpenEnvironment={onOpenEnvironment}
            onOpenInFileBrowser={onOpenInFileBrowser}
            onSetPath={onSetPath}
            onClearPath={onClearPath}
            onSetAlias={onSetAlias}
            onRename={onRename}
            onNewGroup={() => setGroupDialogOpen(true)}
          />
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

          {/* Agent Chat 常驻工作空间不给归档/删除入口（后端同样拒绝，双保险） */}
          {!isDefaultWorkspace && !isAgentChatWorkspace ? (
            <>
              <ContextMenuSeparator />
              <WorkspaceDangerItems workspace={workspace} onDelete={onDelete} />
            </>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>

      {expanded ? (
        <div className="mb-1 ml-[34px]">
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
