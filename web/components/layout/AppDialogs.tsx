// 全局 Dialog 挂载点：所有由 useDialogStore 驱动的弹窗集中在此。
import { useEffect, useState } from "react";
import { openSettingsWindow, usesSettingsWindow } from "@/services/settingsWindowService";
import { handleErrorSilent } from "@/utils";
import SettingsPanel from "@/components/SettingsPanel";
import JournalPanel from "@/components/JournalPanel";
import LocalHistoryPanel from "@/components/LocalHistoryPanel";
import GitTimelinePanel from "@/components/GitTimelinePanel";
import ConflictResolveDialog from "@/components/git/ConflictResolveDialog";
import SessionCleanerPanel from "@/components/SessionCleanerPanel";
import TodoPanel from "@/components/TodoPanel";
import PlansPanel from "@/components/PlansPanel";
import SelfChatPanel from "@/components/SelfChatPanel";
import AiPanelDialog from "@/components/aipanel/AiPanelDialog";
import RecentFilesPicker from "@/components/RecentFilesPicker";
import CommandPalette from "@/components/CommandPalette";
import ShortcutCheatsheet from "@/components/ShortcutCheatsheet";
import TerminalPathLinkDialog from "@/components/panes/TerminalPathLinkDialog";
import TrayQuitConfirmDialog from "@/components/tray/TrayQuitConfirmDialog";
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
  const gitConflictOpen = useDialogStore((s) => s.gitConflictOpen);
  const gitConflictProjectPath = useDialogStore((s) => s.gitConflictProjectPath);
  const gitConflictInitialFile = useDialogStore((s) => s.gitConflictInitialFile);
  const sessionCleanerOpen = useDialogStore((s) => s.sessionCleanerOpen);
  const sessionCleanerProjectPath = useDialogStore((s) => s.sessionCleanerProjectPath);
  const todoOpen = useDialogStore((s) => s.todoOpen);
  const todoScope = useDialogStore((s) => s.todoScope);
  const todoScopeRef = useDialogStore((s) => s.todoScopeRef);
  const plansOpen = useDialogStore((s) => s.plansOpen);
  const plansProjectPath = useDialogStore((s) => s.plansProjectPath);
  const selfChatOpen = useDialogStore((s) => s.selfChatOpen);

  // 桌面设置用独立窗口；建窗失败时退回弹窗，不让入口失效。
  const [settingsWindowFailed, setSettingsWindowFailed] = useState(false);
  const useWindow = usesSettingsWindow() && !settingsWindowFailed;
  useEffect(() => {
    if (!settingsOpen || !useWindow) return;
    openSettingsWindow()
      .then(() => useDialogStore.getState().closeSettings())
      .catch((error) => {
        handleErrorSilent(error, "open settings window");
        setSettingsWindowFailed(true);
      });
  }, [settingsOpen, useWindow]);

  return (
    <>
      <SettingsPanel
        open={settingsOpen && !useWindow}
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
      <ConflictResolveDialog
        open={gitConflictOpen}
        onOpenChange={(open) => open
          ? useDialogStore.getState().openGitConflict(gitConflictProjectPath, gitConflictInitialFile ?? undefined)
          : useDialogStore.getState().closeGitConflict()}
        projectPath={gitConflictProjectPath}
        initialFile={gitConflictInitialFile}
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
      <AiPanelDialog />
      <TerminalPathLinkDialog />
      {/* 托盘退出确认（tray-action/confirm-quit 触发，确认后回调 Rust 退出） */}
      <TrayQuitConfirmDialog />

      {/* 最近文件选择器（Ctrl+E） */}
      <RecentFilesPicker open={recentFilesOpen} onClose={onCloseRecentFiles} />

      {/* 命令面板（Ctrl+K，终端聚焦时放行给终端） */}
      <CommandPalette />

      {/* 快捷键速查表（Ctrl+/，从命令注册中心生成） */}
      <ShortcutCheatsheet />
    </>
  );
}
