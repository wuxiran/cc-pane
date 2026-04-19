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
import { useProvidersStore, useSettingsStore, useSshMachinesStore } from "@/stores";
import { projectCliHooksService } from "@/services";
import {
  detectAppPlatform,
  getWorkspaceDefaultEnvironment,
  getWorkspaceLaunchIssueKey,
  getWorkspaceLaunchIssueValues,
  hasWorkspaceWslPath,
  resolveWorkspaceLaunchOptions,
} from "@/utils";
import type {
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
  const favoriteLaunchIds = useSettingsStore((s) => s.settings?.general.launchFavorites ?? getDefaultSidebarFavoriteLaunchActionIds());
  const saveSettings = useSettingsStore((s) => s.saveSettings);
  const sshMachines = useSshMachinesStore((s) => s.machines);
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
  const showExplicitWslLaunch = isWindows
    && defaultEnvironment === "wsl"
    && !resolveWorkspaceLaunchOptions({
      workspace: ws,
      machines: sshMachines,
      environment: "wsl",
    }).issue;
  const cliLaunchItems = buildSidebarCliLaunchItems(t, showExplicitWslLaunch);
  const favoriteLaunchActions = filterSidebarFavoriteLaunchActions(
    buildSidebarLaunchActions(t, showExplicitWslLaunch),
    favoriteLaunchIds,
  );
  const allLaunchActions = buildSidebarLaunchActions(t, showExplicitWslLaunch);
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
  ) => {
    const { options, issue } = resolveWorkspaceLaunchOptions({
      workspace: ws,
      cliTool,
      machines: sshMachines,
      environment,
    });
    if (!options || issue) {
      toast.error(
        formatLaunchIssue(issue ?? {
          environment: environment ?? getWorkspaceDefaultEnvironment(ws),
          code: "local_path_missing",
        }),
      );
      return;
    }
    onOpenTerminal(options);
  }, [formatLaunchIssue, onOpenTerminal, sshMachines, ws]);

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
            className={`w-full group flex items-center justify-between px-3 py-2.5 mb-1 rounded-xl transition-all duration-300 ${
              expanded
                ? "border border-[var(--app-border)] text-[var(--app-accent)]"
                : "border border-transparent text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
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
            <div className="flex items-center gap-2">
              {dragHandleProps ? (
                <button
                  type="button"
                  aria-label={t("workspaceReorderHandle", {
                    defaultValue: "拖动排序工作空间",
                  })}
                  className="flex h-5 w-5 items-center justify-center rounded-sm text-[var(--app-text-tertiary)] opacity-0 transition-opacity cursor-grab group-hover:opacity-70 hover:text-[var(--app-text-secondary)]"
                  onClick={(event) => event.stopPropagation()}
                  {...dragHandleProps}
                >
                  <GripVertical className="h-3.5 w-3.5" />
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
              className="text-xs px-2 py-0.5 rounded-full text-[var(--app-text-secondary)]"
              style={{ background: "var(--app-hover)" }}
            >
              {ws.projects.length}
            </span>
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent className="w-56">
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Star /> {t("favoriteLaunches", { defaultValue: "常用" })}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-60">
              <ContextMenuItem disabled>
                {t("favoriteLaunchRun", { defaultValue: "启动" })}
              </ContextMenuItem>
              {favoriteLaunchActions.length > 0 ? (
                favoriteLaunchActions.map((action) => (
                  <ContextMenuItem
                    key={`favorite-${action.id}`}
                    onClick={() => openWorkspace(action.cliTool, action.environment)}
                  >
                    <Terminal /> {action.label}
                  </ContextMenuItem>
                ))
              ) : (
                <ContextMenuItem disabled>
                  {t("favoriteLaunchEmpty", { defaultValue: "暂无常用项" })}
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem disabled>
                {t("favoriteLaunchManage", { defaultValue: "显示在常用" })}
              </ContextMenuItem>
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

              {cliLaunchItems.map((item) => (
                <ContextMenuItem
                  key={item.key}
                  onClick={() => openWorkspace(item.cliTool, item.environment)}
                >
                  <Terminal /> {item.label}
                </ContextMenuItem>
              ))}

              <ContextMenuSeparator />
            </>
          ) : null}

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
              <ContextMenuItem onClick={() => onOpenEnvironment(ws)}>
                <Terminal /> {t("workspaceEnv.title", { defaultValue: "运行环境" })}...
              </ContextMenuItem>

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
