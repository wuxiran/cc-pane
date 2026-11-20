// 资源管理器「简洁模式」：Codex 式单列表——新聊天 / 启动终端，置顶，项目，最近。
// 「项目」区一个工作空间一行：点开列出它下面所有项目文件夹的会话（终端会话与 Agent 对话
// 混排，先露出几条，其余收在「展开显示」后面）；悬停出卡片看文件夹、进编辑。
// 系统的默认工作空间和 Agent Chat 工作空间不露出。
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/toast";
import { FolderPlus, MessagesSquare, Rocket } from "lucide-react";
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
import type { OpenTerminalOptions, Workspace } from "@/types";
import { buildLaunchRecordTerminalOptions } from "@/utils";
import { handleErrorSilent } from "@/utils/errorHandler";
import { openNewAgentChat, resumeAgentChat } from "../agentChatResume";
import { sidebarSectionTitleClass } from "../sidebarStyles";
import SimpleSessionRow from "./SimpleSessionRow";
import SimpleWorkspaceEditDialog from "./SimpleWorkspaceEditDialog";
import SimpleWorkspaceRow from "./SimpleWorkspaceRow";
import {
  WORKSPACE_SESSION_PREVIEW,
  defaultContextWorkspace,
  groupByWorkspace,
  pinnedSessions,
  recentSessions,
  userWorkspaces,
  workspaceCwd,
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
  const groups = useMemo(() => groupByWorkspace(sessions, workspaces), [sessions, workspaces]);
  // 哪些工作空间点过「展开显示」（只在本次打开期间记着），以及正在编辑哪一个。
  const [showAll, setShowAll] = useState<readonly string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = editingId ? users.find((ws) => ws.id === editingId) ?? null : null;
  const pinned = useMemo(() => pinnedSessions(sessions, pinnedKeys), [sessions, pinnedKeys]);
  const recent = useMemo(() => recentSessions(sessions, RECENT_LIMIT), [sessions]);
  const contextWorkspace = useMemo(() => defaultContextWorkspace(workspaces, preferredName), [workspaces, preferredName]);

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

  const renderWorkspace = (workspace: Workspace | null, items: SimpleSession[]) => {
    // 折叠状态存在 collapsedSimpleProjects 里，键带前缀，和旧的按项目路径折叠的键不会撞。
    const key = workspace ? `ws:${workspace.id}` : "ws:__other__";
    const isCollapsed = collapsed.includes(key);
    const expandedAll = showAll.includes(key);
    const visible = expandedAll ? items : items.slice(0, WORKSPACE_SESSION_PREVIEW);
    const hiddenCount = items.length - visible.length;
    return (
      <div key={key}>
        <SimpleWorkspaceRow
          workspace={workspace}
          label={workspace ? workspace.alias || workspace.name : t("simple.other")}
          sessionCount={items.length}
          collapsed={isCollapsed}
          isDefaultContext={!!workspace && contextWorkspace?.id === workspace.id}
          hideTerminalActions={hideTerminalActions}
          onToggle={() => toggleProject(key)}
          onNewChat={(ws) => openNewAgentChat(workspaceCwd(ws))}
          onLaunch={(ws) => launch(ws)}
          onSetDefault={(ws) => setPreferred(ws.name)}
          onEdit={(ws) => setEditingId(ws.id)}
        />
        {!isCollapsed && visible.map((session) => renderSession(session, true))}
        {!isCollapsed && (hiddenCount > 0 || expandedAll) && items.length > WORKSPACE_SESSION_PREVIEW && (
          <button
            type="button"
            data-testid="simple-workspace-show-more"
            className="ml-8 rounded px-1 py-1 text-[length:var(--text-row)] text-[var(--app-text-tertiary)] transition-colors hover:text-[var(--app-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
            onClick={() => setShowAll((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]))}
          >
            {t(expandedAll ? "simple.showLess" : "simple.showMore")}
          </button>
        )}
      </div>
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
            groups.map((group) => renderWorkspace(group.workspace, group.sessions))
          )}
        </section>

        {recent.length > 0 && (
          <section aria-label={t("simple.recent")}>
            <div className={`${SECTION_CLASS} ${sidebarSectionTitleClass}`}>{t("simple.recent")}</div>
            {recent.map((session) => renderSession(session, false))}
          </section>
        )}
      </div>
      <SimpleWorkspaceEditDialog workspace={editing} onOpenChange={(open) => { if (!open) setEditingId(null); }} />
    </div>
  );
}
