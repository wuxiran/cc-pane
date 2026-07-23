// 全局 Dialog 挂载点：所有由 useDialogStore 驱动的弹窗集中在此。
import SettingsPanel from "@/components/SettingsPanel";
import JournalPanel from "@/components/JournalPanel";
import LocalHistoryPanel from "@/components/LocalHistoryPanel";
import GitTimelinePanel from "@/components/GitTimelinePanel";
import SessionCleanerPanel from "@/components/SessionCleanerPanel";
import TodoPanel from "@/components/TodoPanel";
import PlansPanel from "@/components/PlansPanel";
import SelfChatPanel from "@/components/SelfChatPanel";
import RecentFilesPicker from "@/components/RecentFilesPicker";
import CommandPalette from "@/components/CommandPalette";
import { useDialogStore } from "@/stores";

interface AppDialogsProps {
  recentFilesOpen: boolean;
  onCloseRecentFiles: () => void;
}

export default function AppDialogs({ recentFilesOpen, onCloseRecentFiles }: AppDialogsProps) {
  const settingsOpen = useDialogStore((s) => s.settingsOpen);
  const journalOpen = useDialogStore((s) => s.journalOpen);
  const journalWorkspaceName = useDialogStore((s) => s.journalWorkspaceName);
  const localHistoryOpen = useDialogStore((s) => s.localHistoryOpen);
  const localHistoryProjectPath = useDialogStore((s) => s.localHistoryProjectPath);
  const localHistoryFilePath = useDialogStore((s) => s.localHistoryFilePath);
  const gitTimelineOpen = useDialogStore((s) => s.gitTimelineOpen);
  const gitTimelineProjectPath = useDialogStore((s) => s.gitTimelineProjectPath);
  const gitTimelineInitialFile = useDialogStore((s) => s.gitTimelineInitialFile);
  const sessionCleanerOpen = useDialogStore((s) => s.sessionCleanerOpen);
  const sessionCleanerProjectPath = useDialogStore((s) => s.sessionCleanerProjectPath);
  const todoOpen = useDialogStore((s) => s.todoOpen);
  const todoScope = useDialogStore((s) => s.todoScope);
  const todoScopeRef = useDialogStore((s) => s.todoScopeRef);
  const plansOpen = useDialogStore((s) => s.plansOpen);
  const plansProjectPath = useDialogStore((s) => s.plansProjectPath);
  const selfChatOpen = useDialogStore((s) => s.selfChatOpen);

  return (
    <>
      <SettingsPanel
        open={settingsOpen}
        onOpenChange={(open) => open ? useDialogStore.getState().openSettings() : useDialogStore.getState().closeSettings()}
      />
      <JournalPanel
        open={journalOpen}
        onOpenChange={(open) => open ? useDialogStore.getState().openJournal(journalWorkspaceName) : useDialogStore.getState().closeJournal()}
        workspaceName={journalWorkspaceName}
      />
      <LocalHistoryPanel
        open={localHistoryOpen}
        onOpenChange={(open) => open ? useDialogStore.getState().openLocalHistory(localHistoryProjectPath, localHistoryFilePath) : useDialogStore.getState().closeLocalHistory()}
        projectPath={localHistoryProjectPath}
        filePath={localHistoryFilePath}
        onOpenFileHistory={(filePath, worktreePath) => {
          useDialogStore.getState().openLocalHistory(worktreePath || localHistoryProjectPath, filePath);
        }}
      />
      <GitTimelinePanel
        open={gitTimelineOpen}
        onOpenChange={(open) => open
          ? useDialogStore.getState().openGitTimeline(gitTimelineProjectPath, gitTimelineInitialFile ?? undefined)
          : useDialogStore.getState().closeGitTimeline()}
        projectPath={gitTimelineProjectPath}
        initialFile={gitTimelineInitialFile}
      />
      <SessionCleanerPanel
        open={sessionCleanerOpen}
        onOpenChange={(open) => open ? useDialogStore.getState().openSessionCleaner(sessionCleanerProjectPath) : useDialogStore.getState().closeSessionCleaner()}
        projectPath={sessionCleanerProjectPath}
      />
      <TodoPanel
        open={todoOpen}
        onOpenChange={(open) => open ? useDialogStore.getState().openTodo(todoScope, todoScopeRef) : useDialogStore.getState().closeTodo()}
        scope={todoScope}
        scopeRef={todoScopeRef}
      />
      <PlansPanel
        open={plansOpen}
        onOpenChange={(open) => open ? useDialogStore.getState().openPlans(plansProjectPath) : useDialogStore.getState().closePlans()}
        projectPath={plansProjectPath}
      />
      <SelfChatPanel
        open={selfChatOpen}
        onOpenChange={(open) => open ? useDialogStore.getState().openSelfChat() : useDialogStore.getState().closeSelfChat()}
      />

      {/* 最近文件选择器（Ctrl+E） */}
      <RecentFilesPicker open={recentFilesOpen} onClose={onCloseRecentFiles} />

      {/* 命令面板（Ctrl+K，终端聚焦时放行给终端） */}
      <CommandPalette />
    </>
  );
}
