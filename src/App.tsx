import { useState, useEffect, useCallback } from "react";
import { Toaster, toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import Sidebar from "@/components/Sidebar";
import MiniView from "@/components/MiniView";
import { PaneContainer } from "@/components/panes";
import SettingsPanel from "@/components/SettingsPanel";
import JournalPanel from "@/components/JournalPanel";
import LocalHistoryPanel from "@/components/LocalHistoryPanel";
import SessionCleanerPanel from "@/components/SessionCleanerPanel";
import {
  usePanesStore,
  useFullscreenStore,
  useThemeStore,
  useShortcutsStore,
  useMiniModeStore,
  useTerminalStatusStore,
  useDialogStore,
  useSettingsStore,
} from "@/stores";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { historyService } from "@/services";

export default function App() {
  const isDark = useThemeStore((s) => s.isDark);
  const isMiniMode = useMiniModeStore((s) => s.isMiniMode);

  const rootPane = usePanesStore((s) => s.rootPane);
  const openProject = usePanesStore((s) => s.openProject);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Dialog 状态（从 store 读取）
  const settingsOpen = useDialogStore((s) => s.settingsOpen);
  const journalOpen = useDialogStore((s) => s.journalOpen);
  const journalWorkspaceName = useDialogStore((s) => s.journalWorkspaceName);
  const localHistoryOpen = useDialogStore((s) => s.localHistoryOpen);
  const localHistoryProjectPath = useDialogStore((s) => s.localHistoryProjectPath);
  const sessionCleanerOpen = useDialogStore((s) => s.sessionCleanerOpen);
  const sessionCleanerProjectPath = useDialogStore((s) => s.sessionCleanerProjectPath);

  // 注册全局快捷键
  useKeyboardShortcuts();

  // 初始化设置 + TerminalStatusStore
  useEffect(() => {
    useSettingsStore.getState().loadSettings();
    useTerminalStatusStore.getState().init();
    return () => useTerminalStatusStore.getState().cleanup();
  }, []);

  // 注册快捷键动作（所有 handler 通过 getState() 获取最新值，无需依赖）
  useEffect(() => {
    const register = useShortcutsStore.getState().registerAction;
    register({
      id: "toggle-sidebar",
      label: "折叠/展开侧边栏",
      handler: () => setSidebarCollapsed((prev) => !prev),
    });
    register({
      id: "toggle-fullscreen",
      label: "切换全屏",
      handler: () => useFullscreenStore.getState().toggleFullscreen(),
    });
    register({
      id: "new-tab",
      label: "新建标签",
      handler: () => {
        const s = usePanesStore.getState();
        if (s.activePaneId) s.addTab(s.activePaneId, "", "");
      },
    });
    register({
      id: "close-tab",
      label: "关闭标签",
      handler: () => {
        const s = usePanesStore.getState();
        if (!s.activePaneId) return;
        const panel = s.findPaneById(s.activePaneId);
        if (panel && panel.type === "panel" && panel.activeTabId) {
          s.closeTab(s.activePaneId, panel.activeTabId);
        }
      },
    });
    register({
      id: "settings",
      label: "打开设置",
      handler: () => useDialogStore.getState().openSettings(),
    });
    register({
      id: "split-right",
      label: "向右分屏",
      handler: () => {
        const s = usePanesStore.getState();
        if (s.activePaneId) s.splitRight(s.activePaneId);
      },
    });
    register({
      id: "split-down",
      label: "向下分屏",
      handler: () => {
        const s = usePanesStore.getState();
        if (s.activePaneId) s.splitDown(s.activePaneId);
      },
    });
    register({
      id: "next-tab",
      label: "下一个标签",
      handler: () => {
        const s = usePanesStore.getState();
        if (s.activePaneId) s.nextTab(s.activePaneId);
      },
    });
    register({
      id: "prev-tab",
      label: "上一个标签",
      handler: () => {
        const s = usePanesStore.getState();
        if (s.activePaneId) s.prevTab(s.activePaneId);
      },
    });
    register({
      id: "toggle-mini-mode",
      label: "切换迷你模式",
      handler: () => useMiniModeStore.getState().toggleMiniMode(),
    });
    for (let i = 1; i <= 9; i++) {
      register({
        id: `switch-tab-${i}`,
        label: `切换到标签 ${i}`,
        handler: () => {
          const s = usePanesStore.getState();
          if (s.activePaneId) s.switchToTab(s.activePaneId, i - 1);
        },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 打开终端
  const handleOpenTerminal = useCallback(
    (path: string, workspaceName?: string, providerId?: string) => {
      const projectId = `proj-${crypto.randomUUID()}`;
      openProject(projectId, path, undefined, workspaceName, providerId);
      const name = path.split(/[/\\]/).pop() || path;
      historyService.add(projectId, name, path).catch(console.error);
    },
    [openProject]
  );

  const handleImport = useCallback(() => {
    toast.info("请在工作空间中点击「导入项目」");
  }, []);

  const handleNew = useCallback(() => {
    toast.info("请先创建工作空间，然后导入项目");
  }, []);

  const handleSettings = useCallback(() => {
    useDialogStore.getState().openSettings();
  }, []);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="app h-full flex flex-col relative z-[1]">
        {/* 渐变球体背景 */}
        <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden">
          <div
            className="absolute rounded-full mix-blend-screen opacity-60"
            style={{
              width: 600,
              height: 600,
              top: -200,
              left: -100,
              background: "var(--app-orb-1)",
              filter: "blur(120px)",
            }}
          />
          <div
            className="absolute rounded-full mix-blend-screen opacity-60"
            style={{
              width: 500,
              height: 500,
              top: "30%",
              right: -150,
              background: "var(--app-orb-2)",
              filter: "blur(150px)",
            }}
          />
          <div
            className="absolute rounded-full mix-blend-screen opacity-60"
            style={{
              width: 400,
              height: 400,
              bottom: -100,
              left: "40%",
              background: "var(--app-orb-3)",
              filter: "blur(130px)",
            }}
          />
        </div>

        {/* Sonner Toast */}
        <Toaster position="top-center" theme={isDark ? "dark" : "light"} richColors />

        {isMiniMode ? (
          <MiniView />
        ) : (
          <>
            {/* 主区域：Sidebar | 主内容区 */}
            <div className="flex-1 flex overflow-hidden relative z-[1]">
              {/* 侧边栏 */}
              <Sidebar
                collapsed={sidebarCollapsed}
                onToggleCollapse={() => setSidebarCollapsed((prev) => !prev)}
                onOpenTerminal={handleOpenTerminal}
                onImport={handleImport}
                onNew={handleNew}
                onSettings={handleSettings}
              />

              {/* 面板区域 */}
              <div className="flex-1 overflow-hidden bg-transparent p-1.5">
                <PaneContainer pane={rootPane} />
              </div>
            </div>
          </>
        )}

        {/* Dialog 组件 */}
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
          onOpenChange={(open) => open ? useDialogStore.getState().openLocalHistory(localHistoryProjectPath) : useDialogStore.getState().closeLocalHistory()}
          projectPath={localHistoryProjectPath}
          filePath=""
        />
        <SessionCleanerPanel
          open={sessionCleanerOpen}
          onOpenChange={(open) => open ? useDialogStore.getState().openSessionCleaner(sessionCleanerProjectPath) : useDialogStore.getState().closeSessionCleaner()}
          projectPath={sessionCleanerProjectPath}
        />
      </div>
    </TooltipProvider>
  );
}
