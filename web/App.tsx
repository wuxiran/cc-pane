import { useCallback } from "react";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import Sidebar from "@/components/Sidebar";
import TitleBar from "@/components/TitleBar";
import ActivityBar from "@/components/ActivityBar";
import StatusBar from "@/components/StatusBar";
import MiniView from "@/components/MiniView";
import { PaneContainer } from "@/components/panes";
import StarredPanel from "@/components/panes/StarredPanel";
import DndPaneProvider from "@/components/panes/DndPaneProvider";
import { FileEditorPanel } from "@/components/editor";
import SettingsPanel from "@/components/SettingsPanel";
import LayoutSwitcherWindow from "@/components/LayoutSwitcherWindow";
import JournalPanel from "@/components/JournalPanel";
import LocalHistoryPanel from "@/components/LocalHistoryPanel";
import SessionCleanerPanel from "@/components/SessionCleanerPanel";
import TodoPanel from "@/components/TodoPanel";
import PlansPanel from "@/components/PlansPanel";
import TodoManager from "@/components/todo/TodoManager";
import SelfChatPanel from "@/components/SelfChatPanel";
import { SelfChatManager } from "@/components/selfchat";
import { HomeDashboard } from "@/components/home";
import { ProvidersPanel } from "@/components/providers";
import ResourceHub from "@/components/resources/ResourceHub";
import ImportConfirmDialog from "@/components/resources/ImportConfirmDialog";
import OrchestrationOverlay from "@/components/orchestration/OrchestrationOverlay";
import BorderlessFloatingButton from "@/components/BorderlessFloatingButton";
import OnboardingGuide from "@/components/OnboardingGuide";
import ErrorBoundary from "@/components/ErrorBoundary";
import WebAuthGate from "@/components/WebAuthGate";
import { LayoutVisibilityContext } from "@/contexts/LayoutVisibilityContext";

import RecentFilesPicker from "@/components/RecentFilesPicker";
import PopupTerminalWindow from "@/components/PopupTerminalWindow";
import MobilePrototype from "@/components/mobile/MobilePrototype";
import {
  usePanesStore,
  useThemeStore,
  useMiniModeStore,
  useDialogStore,
  useActivityBarStore,
  useWorkspacesStore,
} from "@/stores";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useTodoReminders } from "@/hooks/useTodoReminders";
import { useWorkspaceWatcher } from "@/hooks/useWorkspaceWatcher";
import { useOrchestratorListener } from "@/hooks/useOrchestratorListener";
import { useOrphanSessionReconciler } from "@/hooks/useOrphanSessionReconciler";
import useOrchestratorSync from "@/hooks/useOrchestratorSync";
import useLayoutSwitcherSync from "@/hooks/useLayoutSwitcherSync";
import { useLaunchWarnings } from "@/hooks/useLaunchWarnings";
import {
  useSessionLayoutPersistence,
  useSharedLayoutSnapshotSync,
} from "@/hooks/useSessionLayoutPersistence";
import { useTerminalResumeIdBridge } from "@/hooks/useTerminalSessionRestore";
import { useAppLifecycleEarly } from "@/hooks/useAppLifecycleEarly";
import { useAppLifecycleLate } from "@/hooks/useAppLifecycleLate";
import { useShortcutRegistrations } from "@/hooks/useShortcutRegistrations";
import { useOpenTerminal } from "@/hooks/useOpenTerminal";
import { historyService, terminalService, providerService } from "@/services";
import type { Tab, Workspace } from "@/types";

function getMobileWorkspacePath(workspace: Workspace): string | undefined {
  return workspace.path || workspace.projects.find((project) => !project.ssh)?.path || workspace.projects[0]?.path;
}

export default function App() {
  // 弹出窗口路由：mode=popup 时渲染纯终端视图（tabData 通过 IPC 获取）
  const params = new URLSearchParams(window.location.search);
  if (params.get("mode") === "popup") {
    return <PopupTerminalWindow />;
  }
  if (params.get("mode") === "layout-switcher") {
    return <LayoutSwitcherWindow />;
  }
  if (params.get("mode") === "mobile-prototype") {
    return (
      <ErrorBoundary>
        <WebAuthGate>
          <MobilePrototypeRoute />
        </WebAuthGate>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <WebAuthGate>
        <MainApp />
      </WebAuthGate>
    </ErrorBoundary>
  );
}

function MobilePrototypeRoute() {
  useSessionLayoutPersistence();
  useSharedLayoutSnapshotSync();

  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const workspacesLoading = useWorkspacesStore((s) => s.loading);
  const loadWorkspaces = useWorkspacesStore((s) => s.load);
  const updatePinned = useWorkspacesStore((s) => s.updatePinned);
  const updateHidden = useWorkspacesStore((s) => s.updateHidden);
  const updateWorkspaceAlias = useWorkspacesStore((s) => s.updateWorkspaceAlias);
  const renameWorkspace = useWorkspacesStore((s) => s.rename);
  const removeWorkspace = useWorkspacesStore((s) => s.remove);
  const openProject = usePanesStore((s) => s.openProject);
  const openFileExplorer = usePanesStore((s) => s.openFileExplorer);
  const layouts = usePanesStore((s) => s.layouts);
  const currentLayoutId = usePanesStore((s) => s.currentLayoutId);
  const rootPane = usePanesStore((s) => s.rootPane);
  const activePaneId = usePanesStore((s) => s.activePaneId);
  const switchLayout = usePanesStore((s) => s.switchLayout);
  const selectTab = usePanesStore((s) => s.selectTab);
  const setActivePane = usePanesStore((s) => s.setActivePane);
  const activePane = usePanesStore((s) => s.activePane());
  const activeTab = activePane?.tabs.find((tab) => tab.id === activePane.activeTabId) ?? null;
  const mobileTerminal = activePane && activeTab?.contentType === "terminal"
    ? {
        paneId: activePane.id,
        tab: activeTab as Tab,
        onSessionCreated: (sessionId: string, terminalPaneId?: string) => {
          usePanesStore.getState().updateTabSession(activePane.id, activeTab.id, sessionId, terminalPaneId);
        },
        onSessionExited: (_exitCode: number, terminalPaneId?: string) => {
          const latest = usePanesStore.getState().findTabAcrossLayouts(activeTab.id)?.tab;
          if (latest?.ssh) {
            usePanesStore.getState().setTabDisconnected(activePane.id, activeTab.id, true, terminalPaneId);
          }
        },
        onTerminalRef: (_terminalPaneId: string) => {},
        onReconnect: activeTab.ssh
          ? (terminalPaneId: string) => usePanesStore.getState().reconnectTab(activePane.id, activeTab.id, terminalPaneId)
          : undefined,
        onWrite: (sessionId: string, data: string) => terminalService.write(sessionId, data),
        onSubmit: (sessionId: string, text: string) => terminalService.submitToSession(sessionId, text),
      }
    : null;

  const handleOpenProject = useCallback(
    (workspace: Workspace, project: Workspace["projects"][number]) => {
      const projectName = project.alias || project.path.split(/[/\\]/).pop() || project.path;
      const projectId = `proj-${crypto.randomUUID()}`;
      const workspaceSnapshotId = `ws-snapshot-${crypto.randomUUID()}`;
      const launchProfileId = project.launchProfileId ?? workspace.launchProfileId;
      const wsl = project.wslRemotePath ? { remotePath: project.wslRemotePath } : undefined;
      const runtimeKind = project.ssh ? "ssh" : wsl ? "wsl" : "local";
      const workspacePath = getMobileWorkspacePath(workspace);
      openProject({
        projectId,
        projectPath: project.path,
        customTitle: projectName,
        workspaceName: workspace.name,
        workspacePath,
        launchProfileId,
        ssh: project.ssh,
        wsl,
        workspaceSnapshotId,
      });
      historyService.add(
        projectId,
        projectName,
        project.path,
        "none",
        runtimeKind,
        undefined,
        workspace.name,
        workspacePath,
        project.ssh ? project.path : (workspacePath ?? project.path),
        workspace.providerId,
        undefined,
        workspaceSnapshotId,
        launchProfileId,
      ).then(() => {
        window.dispatchEvent(new CustomEvent("cc-panes:history-updated"));
      }).catch((error) => {
        console.error("Failed to record mobile launch history:", error);
      });
    },
    [openProject],
  );

  const handleOpenWorkspaceFileBrowser = useCallback(
    (workspace: Workspace) => {
      const path = getMobileWorkspacePath(workspace);
      if (!path) return;
      openFileExplorer(path, workspace.alias || workspace.name);
    },
    [openFileExplorer],
  );

  return (
    <MobilePrototype
      workspaces={workspaces}
      workspacesLoading={workspacesLoading}
      terminal={mobileTerminal}
      layouts={layouts}
      currentLayoutId={currentLayoutId}
      rootPane={rootPane}
      activePaneId={activePaneId}
      onLoadWorkspaces={loadWorkspaces}
      onOpenProject={handleOpenProject}
      onSwitchLayout={switchLayout}
      onSelectPane={setActivePane}
      onSelectTab={selectTab}
      onToggleWorkspacePinned={(workspace) => updatePinned(workspace.name, !workspace.pinned)}
      onToggleWorkspaceHidden={(workspace) => updateHidden(workspace.name, !workspace.hidden)}
      onOpenWorkspaceFolder={(workspace) => {
        const path = getMobileWorkspacePath(workspace);
        if (!path) return Promise.reject(new Error("当前工作空间没有可打开的路径"));
        return providerService.openPathInExplorer(path);
      }}
      onOpenWorkspaceFileBrowser={handleOpenWorkspaceFileBrowser}
      onSetWorkspaceAlias={(workspace, alias) => updateWorkspaceAlias(workspace.name, alias)}
      onRenameWorkspace={(workspace, name) => renameWorkspace(workspace.name, name)}
      onDeleteWorkspace={(workspace) => removeWorkspace(workspace.name)}
    />
  );
}

function MainApp() {
  useSessionLayoutPersistence();
  useSharedLayoutSnapshotSync();

  const isDark = useThemeStore((s) => s.isDark);
  const isMiniMode = useMiniModeStore((s) => s.isMiniMode);

  const rootPane = usePanesStore((s) => s.rootPane);
  const layouts = usePanesStore((s) => s.layouts);
  const currentLayoutId = usePanesStore((s) => s.currentLayoutId);

  const sidebarVisible = useActivityBarStore((s) => s.sidebarVisible);
  const activeView = useActivityBarStore((s) => s.activeView);
  const appViewMode = useActivityBarStore((s) => s.appViewMode);
  const orchestrationOverlayOpen = useActivityBarStore((s) => s.orchestrationOverlayOpen);
  const closeOrchestrationOverlay = useActivityBarStore((s) => s.closeOrchestrationOverlay);

  const selectedWorkspace = useWorkspacesStore((s) => s.selectedWorkspace);
  const showOrchestrationOverlay =
    orchestrationOverlayOpen ||
    appViewMode === "orchestration" ||
    (activeView === "orchestration" && sidebarVisible);
  const effectiveAppViewMode = appViewMode === "orchestration" ? "panes" : appViewMode;
  const shouldShowSidebar = sidebarVisible && activeView !== "orchestration";

  // Dialog 状态（从 store 读取）
  const settingsOpen = useDialogStore((s) => s.settingsOpen);
  const journalOpen = useDialogStore((s) => s.journalOpen);
  const journalWorkspaceName = useDialogStore((s) => s.journalWorkspaceName);
  const localHistoryOpen = useDialogStore((s) => s.localHistoryOpen);
  const localHistoryProjectPath = useDialogStore((s) => s.localHistoryProjectPath);
  const localHistoryFilePath = useDialogStore((s) => s.localHistoryFilePath);
  const sessionCleanerOpen = useDialogStore((s) => s.sessionCleanerOpen);
  const sessionCleanerProjectPath = useDialogStore((s) => s.sessionCleanerProjectPath);
  const todoOpen = useDialogStore((s) => s.todoOpen);
  const todoScope = useDialogStore((s) => s.todoScope);
  const todoScopeRef = useDialogStore((s) => s.todoScopeRef);
  const plansOpen = useDialogStore((s) => s.plansOpen);
  const plansProjectPath = useDialogStore((s) => s.plansProjectPath);
  const selfChatOpen = useDialogStore((s) => s.selfChatOpen);

  // 注册全局快捷键
  useKeyboardShortcuts();

  // Todo 提醒轮询
  useTodoReminders();

  // 监听外部工作空间变更（文件系统 watcher）
  useWorkspaceWatcher();

  // 监听 Orchestrator 编排事件（自我对话 Claude 启动新任务）
  useOrchestratorListener();

  // 孤儿终端会话对账回收（仅桌面端；daemon TTL 兜底覆盖 app 关闭时段）
  useOrphanSessionReconciler();

  // fix(M4) review: Orchestrator 同步提升到 App 顶层，全局只挂一次。
  useOrchestratorSync();

  // Layout switcher 浮窗与主窗布局状态同步。
  useLayoutSwitcherSync();

  // 启动非致命警告（如所选启动配置因 CLI/环境不匹配被回落）toast 提示。
  useLaunchWarnings();

  // 以下生命周期 hook 的调用顺序保持原 App.tsx 中 effect 的注册顺序，勿随意调整：
  // 通知音/全局 API/terminal-exit → resumeId 桥接 → 初始化/主题/历史/Ctrl+E/popup → 快捷键注册 → 打开终端
  useAppLifecycleEarly();
  useTerminalResumeIdBridge();
  const { recentFilesOpen, closeRecentFiles } = useAppLifecycleLate();
  useShortcutRegistrations();
  const handleOpenTerminal = useOpenTerminal();

  return (
    <TooltipProvider delayDuration={300}>
      <div className="app h-full flex flex-col relative z-[1]">
        {/* 渐变球体背景（仅 Dark 模式） */}
        {isDark && (
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
        )}

        {/* Sonner Toast */}
        <Toaster position="top-center" theme={isDark ? "dark" : "light"} richColors />

        {isMiniMode ? (
          <MiniView />
        ) : (
          <>
            <TitleBar
              workspaceName={selectedWorkspace()?.alias || selectedWorkspace()?.name}
            />
            {/* 主区域：ActivityBar | Sidebar/Todo | 主内容区 */}
            <div className="flex-1 flex overflow-hidden relative z-[1]">
              <ActivityBar />
              {effectiveAppViewMode === "home" ? (
                /* 首页仪表盘：占满 ActivityBar 右侧所有空间 */
                <div className="flex-1 overflow-hidden">
                  <HomeDashboard onOpenTerminal={handleOpenTerminal} />
                </div>
              ) : effectiveAppViewMode === "todo" ? (
                /* Todo 全屏模式：占满 ActivityBar 右侧所有空间 */
                <div className="flex-1 overflow-hidden">
                  <TodoManager scope="" scopeRef="" />
                </div>
              ) : effectiveAppViewMode === "selfchat" ? (
                /* Self-Chat 全屏模式 */
                <div className="flex-1 overflow-hidden">
                  <SelfChatManager />
                </div>
              ) : effectiveAppViewMode === "providers" ? (
                /* Providers 全屏模式（旧入口，保留兼容） */
                <div className="flex-1 overflow-hidden">
                  <ProvidersPanel />
                </div>
              ) : effectiveAppViewMode === "resources" ? (
                /* 资源中心：Provider / Skills / MCP 三合一大页面 */
                <div className="flex-1 overflow-hidden">
                  <ResourceHub />
                </div>
              ) : effectiveAppViewMode === "files" ? (
                /* Files 模式：侧边栏（文件浏览器）+ 文件编辑面板 */
                <>
                  {shouldShowSidebar && (
                    <Sidebar
                      activeView={activeView}
                      onOpenTerminal={handleOpenTerminal}
                    />
                  )}
                  <div className="flex-1 overflow-hidden" style={{ background: "var(--app-panel-bg)" }}>
                    <FileEditorPanel />
                  </div>
                </>
              ) : (
                <>
                  {/* 侧边栏 */}
                  {shouldShowSidebar && (
                    <Sidebar
                      activeView={activeView}
                      onOpenTerminal={handleOpenTerminal}
                    />
                  )}
                  {/* 面板区域 */}
                  <div className="flex-1 overflow-hidden" style={{ background: "var(--app-panel-bg)" }}>
                    <DndPaneProvider>
                      {layouts.map((layout) => {
                        const isCurrent = layout.id === currentLayoutId;
                        return (
                          <LayoutVisibilityContext.Provider key={layout.id} value={isCurrent}>
                            <div
                              className="h-full w-full"
                              style={{ display: isCurrent ? "block" : "none" }}
                            >
                              {layout.kind === "starred" ? (
                                <StarredPanel />
                              ) : (
                                <PaneContainer pane={isCurrent ? rootPane : layout.rootPane} />
                              )}
                            </div>
                          </LayoutVisibilityContext.Provider>
                        );
                      })}
                    </DndPaneProvider>
                  </div>
                </>
              )}
              {showOrchestrationOverlay && (
                <OrchestrationOverlay onClose={closeOrchestrationOverlay} />
              )}
            </div>
            <StatusBar />
          </>
        )}

        {/* 无边框浮动退出按钮 */}
        <BorderlessFloatingButton />

        {/* 一键导入确认弹窗（deep-link ccpanes://…） */}
        <ImportConfirmDialog />

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
          onOpenChange={(open) => open ? useDialogStore.getState().openLocalHistory(localHistoryProjectPath, localHistoryFilePath) : useDialogStore.getState().closeLocalHistory()}
          projectPath={localHistoryProjectPath}
          filePath={localHistoryFilePath}
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

        {/* 新手引导 */}
        <OnboardingGuide />

        {/* 最近文件选择器 */}
        <RecentFilesPicker open={recentFilesOpen} onClose={closeRecentFiles} />
      </div>
    </TooltipProvider>
  );
}
