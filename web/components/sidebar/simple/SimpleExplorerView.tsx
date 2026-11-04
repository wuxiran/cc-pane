// 资源管理器「简洁模式」：Codex 式单列表——新聊天 / 启动终端，置顶，项目（按工作空间顺序，
// 项目下混排终端会话与 Agent 对话），最近。系统的默认工作空间和 Agent Chat 工作空间不露出。
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Check, ChevronRight, Folder, FolderOpen, FolderPlus, MessagesSquare, Rocket, TerminalSquare,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { EmptyState } from "@/components/ui/EmptyState";
import { useRowTypeAhead } from "@/hooks/useTypeAhead";
import { historyService } from "@/services/historyService";
import { agentChatService } from "@/services/agentChatService";
import {
  formatKeyCombo,
  useDialogStore,
  useExplorerSectionsStore,
  useSettingsStore,
  useSshMachinesStore,
  useWorkspacesStore,
} from "@/stores";
import { AGENT_CHAT_HISTORY_CHANGED_EVENT } from "@/stores/agentChatEvents";
import type { OpenTerminalOptions, Workspace, WorkspaceProject } from "@/types";
import { buildLaunchRecordTerminalOptions, getProjectName } from "@/utils";
import { handleErrorSilent } from "@/utils/errorHandler";
import { openNewAgentChat, resumeAgentChat } from "../agentChatResume";
import { sidebarEntityCountClass, sidebarSectionTitleClass } from "../sidebarStyles";
import SimpleSessionRow from "./SimpleSessionRow";
import {
  defaultContextWorkspace,
  groupByProject,
  pinnedSessions,
  recentSessions,
  userWorkspaces,
  type SimpleSession,
} from "./simpleExplorerModel";
import { HISTORY_UPDATED_EVENT, useSimpleSessions } from "./useSimpleSessions";

const ACTION_ROW_CLASS =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[length:var(--text-row)] text-[var(--app-text-secondary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]";
const SECTION_CLASS = "px-2 pb-1 pt-3";
const RECENT_LIMIT = 8;

interface SimpleExplorerViewProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
  /** Agent Chat 专用布局里不放终端入口 */
  hideTerminalActions?: boolean;
}

export default function SimpleExplorerView({ onOpenTerminal, hideTerminalActions = false }: SimpleExplorerViewProps) {
  const { t } = useTranslation("sidebar");
  const onTypeAhead = useRowTypeAhead();
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const expandedWorkspaceId = useWorkspacesStore((s) => s.expandedWorkspaceId);
  const expandedProjectId = useWorkspacesStore((s) => s.expandedProjectId);
  const machines = useSshMachinesStore((s) => s.machines);
  const newTabBinding = useSettingsStore((s) => s.settings?.shortcuts.bindings["new-tab"] ?? "Ctrl+T");
  const preferredName = useExplorerSectionsStore((s) => s.preferredContextWorkspaceName);
  const setPreferred = useExplorerSectionsStore((s) => s.setPreferredContextWorkspace);
  const pinnedKeys = useExplorerSectionsStore((s) => s.pinnedSessionKeys);
  const togglePin = useExplorerSectionsStore((s) => s.togglePinnedSession);
  const collapsed = useExplorerSectionsStore((s) => s.collapsedSimpleProjects);
  const toggleProject = useExplorerSectionsStore((s) => s.toggleSimpleProject);

  const { sessions } = useSimpleSessions();
  const users = useMemo(() => userWorkspaces(workspaces), [workspaces]);
  const groups = useMemo(() => groupByProject(sessions, workspaces), [sessions, workspaces]);
  const pinned = useMemo(() => pinnedSessions(sessions, pinnedKeys), [sessions, pinnedKeys]);
  const recent = useMemo(() => recentSessions(sessions, RECENT_LIMIT), [sessions]);
  const contextWorkspace = useMemo(() => defaultContextWorkspace(workspaces, preferredName), [workspaces, preferredName]);
  const multiWorkspace = users.length > 1;

  // 无选中项目时落到默认上下文工作空间（系统默认工作空间不参与）
  const selectedWorkspace = workspaces.find((ws) => ws.id === expandedWorkspaceId) ?? null;
  const selectedProjectPath = selectedWorkspace?.projects.find((p) => p.id === expandedProjectId)?.path;

  const launch = useCallback((workspace: Workspace | null, projectPath?: string) => {
    const ctx = {
      ...(workspace ? { workspaceName: workspace.name } : {}),
      ...(projectPath ? { projectPath } : {}),
    };
    useDialogStore.getState().openLauncher(Object.keys(ctx).length > 0 ? ctx : undefined);
  }, []);

  const openSession = useCallback((session: SimpleSession) => {
    if (session.kind === "terminal") onOpenTerminal(buildLaunchRecordTerminalOptions(session.record, workspaces, machines));
    else resumeAgentChat(session.entry);
  }, [onOpenTerminal, workspaces, machines]);

  const deleteSession = useCallback(async (session: SimpleSession) => {
    try {
      if (session.kind === "terminal") {
        await historyService.delete(session.record.id);
        window.dispatchEvent(new Event(HISTORY_UPDATED_EVENT));
      } else {
        await agentChatService.deleteHistory(session.entry.acpSessionId);
        window.dispatchEvent(new Event(AGENT_CHAT_HISTORY_CHANGED_EVENT));
      }
      if (pinnedKeys.includes(session.key)) togglePin(session.key);
    } catch (error) {
      handleErrorSilent(error, "delete session");
      toast.error(t("simple.deleteFailed"));
    }
  }, [pinnedKeys, togglePin, t]);

  const renderSession = (session: SimpleSession, nested: boolean) => (
    <SimpleSessionRow
      key={session.key}
      session={session}
      nested={nested}
      pinned={pinnedKeys.includes(session.key)}
      onOpen={openSession}
      onTogglePin={(item) => togglePin(item.key)}
      onDelete={(item) => void deleteSession(item)}
    />
  );

  const renderProject = (workspace: Workspace | null, project: WorkspaceProject | null, items: SimpleSession[]) => {
    const path = project?.path ?? "";
    const name = project ? project.alias || getProjectName(project.path) : t("simple.other");
    const isCollapsed = project ? collapsed.includes(path) : false;
    const row = (
      <button
        type="button"
        data-testid="simple-project-row"
        data-project-path={path || undefined}
        data-typeahead-label={name}
        aria-expanded={!isCollapsed}
        className="group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
        onClick={() => project && toggleProject(path)}
      >
        <ChevronRight className={`size-3.5 shrink-0 text-[var(--app-text-tertiary)] transition-transform ${isCollapsed ? "" : "rotate-90"}`} />
        {isCollapsed
          ? <Folder className="size-4 shrink-0 text-[var(--app-text-tertiary)] transition-colors group-hover:text-[var(--app-text-secondary)]" />
          : <FolderOpen className="size-4 shrink-0 text-[var(--app-text-secondary)]" />}
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-row)] font-medium text-[var(--app-text-primary)]">{name}</span>
        {items.length > 0 && <span className={sidebarEntityCountClass}>{items.length}</span>}
      </button>
    );
    return (
      <div key={project?.id ?? "__other__"}>
        {project ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
            <ContextMenuContent className="w-48">
              <ContextMenuItem onClick={() => openNewAgentChat(project.path)}>
                <MessagesSquare /> {t("simple.newChatHere")}
              </ContextMenuItem>
              {!hideTerminalActions && (
                <ContextMenuItem onClick={() => launch(workspace, project.path)}>
                  <TerminalSquare /> {t("simple.launchHere")}
                </ContextMenuItem>
              )}
            </ContextMenuContent>
          </ContextMenu>
        ) : row}
        {!isCollapsed && items.map((session) => renderSession(session, true))}
      </div>
    );
  };

  const renderWorkspaceCaption = (workspace: Workspace | null) => {
    if (!multiWorkspace && workspace) return null;
    const label = workspace ? workspace.alias || workspace.name : t("simple.other");
    const caption = (
      <div className={`${SECTION_CLASS} flex items-center gap-1 ${sidebarSectionTitleClass}`} data-testid="simple-workspace-caption">
        <span className="truncate">{label}</span>
        {workspace && contextWorkspace?.id === workspace.id && <Check className="size-3 shrink-0" aria-label={t("simple.defaultContext")} />}
      </div>
    );
    if (!workspace) return caption;
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{caption}</ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem onClick={() => setPreferred(workspace.name)}>
            <Check /> {t("simple.setDefaultContext")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  return (
    <div className="flex h-full flex-col" data-testid="simple-explorer">
      <div className="shrink-0 px-3">
        <button type="button" className={ACTION_ROW_CLASS} onClick={() => openNewAgentChat(selectedProjectPath || contextWorkspace?.path)}>
          <MessagesSquare className="size-4 shrink-0" strokeWidth={1.6} />
          {t("simple.newChat")}
        </button>
        {!hideTerminalActions && (
          <button type="button" className={ACTION_ROW_CLASS} onClick={() => launch(selectedWorkspace ?? contextWorkspace, selectedProjectPath)}>
            <Rocket className="size-4 shrink-0" strokeWidth={1.6} />
            {t("launchTerminal")}
            <kbd className="ml-auto text-[length:var(--text-micro)] font-normal tabular-nums text-[var(--app-text-tertiary)]">
              {formatKeyCombo(newTabBinding)}
            </kbd>
          </button>
        )}
      </div>

      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-2" onKeyDown={onTypeAhead}>
        {pinned.length > 0 && (
          <section aria-label={t("simple.pinned")}>
            <div className={`${SECTION_CLASS} ${sidebarSectionTitleClass}`}>{t("simple.pinned")}</div>
            {pinned.map((session) => renderSession(session, false))}
          </section>
        )}

        <section aria-label={t("simple.projects")}>
          <div className={`${SECTION_CLASS} ${sidebarSectionTitleClass}`}>{t("simple.projects")}</div>
          {users.length === 0 ? (
            <EmptyState
              icon={FolderPlus}
              title={t("simple.emptyTitle")}
              description={t("simple.emptyHint")}
              action={{ label: t("newWorkspace"), onClick: () => useDialogStore.getState().requestNewWorkspace() }}
            />
          ) : (
            groups.map((group) => (
              <div key={group.workspace?.id ?? "__other__"}>
                {renderWorkspaceCaption(group.workspace)}
                {group.projects.map(({ project, sessions: items }) => renderProject(group.workspace, project, items))}
              </div>
            ))
          )}
        </section>

        {recent.length > 0 && (
          <section aria-label={t("simple.recent")}>
            <div className={`${SECTION_CLASS} ${sidebarSectionTitleClass}`}>{t("simple.recent")}</div>
            {recent.map((session) => renderSession(session, false))}
          </section>
        )}
      </div>
    </div>
  );
}
