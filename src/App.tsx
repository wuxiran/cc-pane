import { useEffect, useCallback, useRef, useState } from "react";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import Sidebar from "@/components/Sidebar";
import TitleBar from "@/components/TitleBar";
import ActivityBar from "@/components/ActivityBar";
import StatusBar from "@/components/StatusBar";
import MiniView from "@/components/MiniView";
import { PaneContainer } from "@/components/panes";
import { FileEditorPanel } from "@/components/editor";
import SettingsPanel from "@/components/SettingsPanel";
import JournalPanel from "@/components/JournalPanel";
import LocalHistoryPanel from "@/components/LocalHistoryPanel";
import SessionCleanerPanel from "@/components/SessionCleanerPanel";
import TodoPanel from "@/components/TodoPanel";
import PlansPanel from "@/components/PlansPanel";
import TodoManager from "@/components/todo/TodoManager";
import SelfChatPanel from "@/components/SelfChatPanel";
import { SelfChatManager } from "@/components/selfchat";
import BorderlessFloatingButton from "@/components/BorderlessFloatingButton";
import ErrorBoundary from "@/components/ErrorBoundary";
import QuickSearch from "@/components/QuickSearch";
import {
  usePanesStore,
  useFullscreenStore,
  useThemeStore,
  useShortcutsStore,
  useMiniModeStore,
  useTerminalStatusStore,
  useDialogStore,
  useSettingsStore,
  useActivityBarStore,
  useWorkspacesStore,
} from "@/stores";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useTodoReminders } from "@/hooks/useTodoReminders";
import { useWorkspaceWatcher } from "@/hooks/useWorkspaceWatcher";
import { useOrchestratorListener } from "@/hooks/useOrchestratorListener";
import { historyService, terminalService, localHistoryService, hooksService } from "@/services";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import { isTauriReady, waitForTauri } from "@/utils";
import { registerGlobalApi } from "@/utils/globalApi";
import i18n from "@/i18n";

import type { PaneNode, Panel as PanelType } from "@/types";

interface SessionTrackInfo {
  recordId: number;
  projectPath: string;
  claudeSessionId?: string;
}

/** 递归遍历 pane 树，收集所有 Panel 节点 */
function getAllPanels(pane: PaneNode): PanelType[] {
  if (pane.type === "panel") return [pane];
  return pane.children.flatMap(getAllPanels);
}

export default function App() {
  return (
    <ErrorBoundary>
      <MainApp />
    </ErrorBoundary>
  );
}

function MainApp() {
  const isDark = useThemeStore((s) => s.isDark);
  const isMiniMode = useMiniModeStore((s) => s.isMiniMode);

  const rootPane = usePanesStore((s) => s.rootPane);
  const openProject = usePanesStore((s) => s.openProject);

  const sidebarVisible = useActivityBarStore((s) => s.sidebarVisible);
  const activeView = useActivityBarStore((s) => s.activeView);
  const appViewMode = useActivityBarStore((s) => s.appViewMode);

  const selectedWorkspace = useWorkspacesStore((s) => s.selectedWorkspace);

  // QuickSearch 状态
  const [quickSearchOpen, setQuickSearchOpen] = useState(false);
  const openQuickSearch = useCallback(() => setQuickSearchOpen(true), []);
  const closeQuickSearch = useCallback(() => setQuickSearchOpen(false), []);

  // Session tracking map: ptySessionId -> { recordId, projectPath, claudeSessionId }
  const sessionMapRef = useRef<Map<string, SessionTrackInfo>>(new Map());

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
  const pendingLaunch = useDialogStore((s) => s.pendingLaunch);
  const clearPendingLaunch = useDialogStore((s) => s.clearPendingLaunch);

  // 注册全局快捷键
  useKeyboardShortcuts();

  // Todo 提醒轮询
  useTodoReminders();

  // 监听外部工作空间变更（文件系统 watcher）
  useWorkspaceWatcher();

  // 监听 Orchestrator 编排事件（自我对话 Claude 启动新任务）
  useOrchestratorListener();

  // 注册全局 API（Skill 用）
  useEffect(() => {
    registerGlobalApi();
  }, []);

  // 初始化设置 + TerminalStatusStore（等待 Tauri IPC 就绪）
  useEffect(() => {
    let cancelled = false;
    waitForTauri().then(async (ready) => {
      if (cancelled || !ready) return;
      await useSettingsStore.getState().loadSettings();
      if (cancelled) return;
      // 从 Settings 同步语言到 i18n
      const lang = useSettingsStore.getState().settings?.general.language;
      if (lang && lang !== i18n.language) {
        i18n.changeLanguage(lang);
      }
      useTerminalStatusStore.getState().init();
    });
    return () => {
      cancelled = true;
      useTerminalStatusStore.getState().cleanup();
    };
  }, []);

  // Ctrl+P 全局快捷键：打开 QuickSearch
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "p") {
        e.preventDefault();
        setQuickSearchOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 监听 terminal-exit 事件，提取 last prompt
  useEffect(() => {
    if (!isTauriReady()) return;
    let unlisten: (() => void) | null = null;
    getCurrentWebview().listen<{ sessionId: string }>("terminal-exit", async (e) => {
      const info = sessionMapRef.current.get(e.payload.sessionId);
      if (info?.claudeSessionId) {
        try {
          const lastPrompt = await invoke<string | null>("extract_last_prompt", {
            projectPath: info.projectPath,
            sessionId: info.claudeSessionId,
          });
          if (lastPrompt) {
            await historyService.updateLastPrompt(info.recordId, lastPrompt);
          }
        } catch (err) {
          console.error("Failed to extract last prompt:", err);
        }
      }
      sessionMapRef.current.delete(e.payload.sessionId);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // 注册快捷键动作（所有 handler 通过 getState() 获取最新值，无需依赖）
  useEffect(() => {
    const register = useShortcutsStore.getState().registerAction;
    register({
      id: "toggle-sidebar",
      label: i18n.t("toggle-sidebar", { ns: "shortcuts" }),
      handler: () => useActivityBarStore.getState().toggleSidebar(),
    });
    register({
      id: "toggle-fullscreen",
      label: i18n.t("toggle-fullscreen", { ns: "shortcuts" }),
      handler: () => useFullscreenStore.getState().toggleFullscreen(),
    });
    register({
      id: "new-tab",
      label: i18n.t("new-tab", { ns: "shortcuts" }),
      handler: () => {
        const s = usePanesStore.getState();
        if (s.activePaneId) s.addTab(s.activePaneId, "", "");
      },
    });
    register({
      id: "close-tab",
      label: i18n.t("close-tab", { ns: "shortcuts" }),
      handler: () => {
        const s = usePanesStore.getState();
        if (!s.activePaneId) return;
        const panel = s.findPaneById(s.activePaneId);
        if (panel && panel.type === "panel" && panel.activeTabId) {
          const tab = panel.tabs.find((t) => t.id === panel.activeTabId);
          if (tab?.sessionId) {
            terminalService.killSession(tab.sessionId).catch(console.error);
          }
          s.closeTab(s.activePaneId, panel.activeTabId);
        }
      },
    });
    register({
      id: "settings",
      label: i18n.t("settings", { ns: "shortcuts" }),
      handler: () => useDialogStore.getState().openSettings(),
    });
    register({
      id: "split-right",
      label: i18n.t("split-right", { ns: "shortcuts" }),
      handler: () => {
        const s = usePanesStore.getState();
        if (s.activePaneId) s.splitRight(s.activePaneId);
      },
    });
    register({
      id: "split-down",
      label: i18n.t("split-down", { ns: "shortcuts" }),
      handler: () => {
        const s = usePanesStore.getState();
        if (s.activePaneId) s.splitDown(s.activePaneId);
      },
    });
    register({
      id: "next-tab",
      label: i18n.t("next-tab", { ns: "shortcuts" }),
      handler: () => {
        const s = usePanesStore.getState();
        if (s.activePaneId) s.nextTab(s.activePaneId);
      },
    });
    register({
      id: "prev-tab",
      label: i18n.t("prev-tab", { ns: "shortcuts" }),
      handler: () => {
        const s = usePanesStore.getState();
        if (s.activePaneId) s.prevTab(s.activePaneId);
      },
    });
    register({
      id: "toggle-mini-mode",
      label: i18n.t("toggle-mini-mode", { ns: "shortcuts" }),
      handler: () => useMiniModeStore.getState().toggleMiniMode(),
    });
    register({
      id: "show-explorer",
      label: "Explorer",
      handler: () => useActivityBarStore.getState().toggleView("explorer"),
    });
    register({
      id: "show-search",
      label: "Search",
      handler: () => useActivityBarStore.getState().toggleView("search"),
    });
    register({
      id: "show-sessions",
      label: "Sessions",
      handler: () => useActivityBarStore.getState().toggleView("sessions"),
    });
    register({
      id: "show-files",
      label: "Files",
      handler: () => useActivityBarStore.getState().toggleFilesMode(),
    });
    for (let i = 1; i <= 9; i++) {
      register({
        id: `switch-tab-${i}`,
        label: i18n.t("switch-tab", { ns: "shortcuts", index: i }),
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
    (path: string, workspaceName?: string, providerId?: string, workspacePath?: string, launchClaude?: boolean, resumeId?: string) => {
      const projectId = `proj-${crypto.randomUUID()}`;
      openProject(projectId, path, resumeId, workspaceName, providerId, workspacePath, launchClaude ?? !!resumeId);
      const name = path.split(/[/\\]/).pop() || path;

      // Resume 场景：更新已有记录时间戳，不创建新记录
      // launchCwd: Claude CLI 实际启动目录，决定 session 文件存储位置
      const launchCwd = workspacePath ?? path;

      const recordPromise = resumeId
        ? historyService.touchBySessionId(resumeId).then((existingId) => {
            if (existingId !== null) {
              window.dispatchEvent(new CustomEvent('cc-panes:history-updated'));
              return existingId;
            }
            // 回退：无已有记录时创建新记录
            return historyService.add(projectId, name, path, workspaceName, workspacePath, launchCwd).then((newId) => {
              historyService.updateSessionId(newId, resumeId).then(() => {
                window.dispatchEvent(new CustomEvent('cc-panes:history-updated'));
              }).catch(console.error);
              return newId;
            });
          })
        : historyService.add(projectId, name, path, workspaceName, workspacePath, launchCwd);

      recordPromise.then((recordId) => {
        // 获取新创建 tab 的 ptySessionId 用于 tracking（等 store 更新后）
        setTimeout(() => {
          const state = usePanesStore.getState();
          const allPanels = getAllPanels(state.rootPane);
          for (const panel of allPanels) {
            for (const tab of panel.tabs) {
              if (tab.projectId === projectId && tab.sessionId) {
                sessionMapRef.current.set(tab.sessionId, {
                  recordId,
                  projectPath: path,
                  claudeSessionId: resumeId,
                });
              }
            }
          }
        }, 500);

        // 新启动 Claude（非 resume）时，轮询获取 claudeSessionId
        // 方式 1：session-state.json（hook 写入）
        // 方式 2：~/.claude/projects/ 扫描（无需 hook）
        if (launchClaude && !resumeId) {
          const startTime = new Date().toISOString();
          let attempts = 0;
          const maxAttempts = 15; // 30 秒（15 × 2s），两种检测方式足够
          const updateSessionMap = (rid: number, sessionId: string) => {
            for (const [ptyId, info] of sessionMapRef.current) {
              if (info.recordId === rid) {
                info.claudeSessionId = sessionId;
                sessionMapRef.current.set(ptyId, info);
              }
            }
          };
          const interval = setInterval(async () => {
            attempts++;
            if (attempts > maxAttempts) {
              clearInterval(interval);
              return;
            }
            try {
              // 方式 1：session-state.json（hook 写入到 CLAUDE_PROJECT_DIR）
              const state = await historyService.readSessionState(path);
              console.debug(`[session-detect] method1: pollPath=${path} result=${state?.claudeSessionId ?? "null"} attempt=${attempts}`);
              if (state?.claudeSessionId) {
                clearInterval(interval);
                await historyService.updateSessionId(recordId, state.claudeSessionId);
                window.dispatchEvent(new CustomEvent('cc-panes:history-updated'));
                updateSessionMap(recordId, state.claudeSessionId);
                return;
              }
              // 方式 2：~/.claude/projects/ 扫描（无需 hook）
              const detectedId = await historyService.detectClaudeSession(path, workspacePath, startTime);
              console.debug(`[session-detect] method2: projectPath=${path} wsPath=${workspacePath} after=${startTime} result=${detectedId ?? "null"} attempt=${attempts}`);
              if (detectedId) {
                clearInterval(interval);
                await historyService.updateSessionId(recordId, detectedId);
                window.dispatchEvent(new CustomEvent('cc-panes:history-updated'));
                updateSessionMap(recordId, detectedId);
                return;
              }
            } catch (err) {
              console.warn("[session-detect] polling error:", err);
            }
          }, 2000);
        }
      }).catch(console.error);

      localHistoryService.initProjectHistory(path).catch(console.error);
      // CC 启动时自动创建项目快照，方便后续项目级恢复
      if (launchClaude || resumeId) {
        hooksService.enableAll(workspacePath || path).catch(console.error);
        localHistoryService.createAutoLabel(
          workspacePath || path,
          `CC Session: ${new Date().toLocaleString()}`,
          "claude_session"
        ).catch(console.error);
      }
    },
    [openProject]
  );

  // 监听 pendingLaunch（从 Settings Provider 启动）
  useEffect(() => {
    if (pendingLaunch) {
      handleOpenTerminal(
        pendingLaunch.path,
        pendingLaunch.workspaceName,
        pendingLaunch.providerId,
        pendingLaunch.workspacePath,
        true
      );
      clearPendingLaunch();
    }
  }, [pendingLaunch, clearPendingLaunch, handleOpenTerminal]);

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
              onOpenQuickSearch={openQuickSearch}
            />
            {/* 主区域：ActivityBar | Sidebar/Todo | 主内容区 */}
            <div className="flex-1 flex overflow-hidden relative z-[1]">
              <ActivityBar />
              {appViewMode === "todo" ? (
                /* Todo 全屏模式：占满 ActivityBar 右侧所有空间 */
                <div className="flex-1 overflow-hidden">
                  <TodoManager scope="" scopeRef="" />
                </div>
              ) : appViewMode === "selfchat" ? (
                /* Self-Chat 全屏模式 */
                <div className="flex-1 overflow-hidden">
                  <SelfChatManager />
                </div>
              ) : appViewMode === "files" ? (
                /* Files 模式：侧边栏（文件浏览器）+ 文件编辑面板 */
                <>
                  {sidebarVisible && (
                    <Sidebar
                      activeView={activeView}
                      onOpenTerminal={handleOpenTerminal}
                    />
                  )}
                  <div className="flex-1 overflow-hidden bg-transparent p-1.5">
                    <FileEditorPanel />
                  </div>
                </>
              ) : (
                <>
                  {/* 侧边栏 */}
                  {sidebarVisible && (
                    <Sidebar
                      activeView={activeView}
                      onOpenTerminal={handleOpenTerminal}
                    />
                  )}
                  {/* 面板区域 */}
                  <div className="flex-1 overflow-hidden bg-transparent p-1.5">
                    <PaneContainer pane={rootPane} />
                  </div>
                </>
              )}
            </div>
            <StatusBar />
          </>
        )}

        {/* 无边框浮动退出按钮 */}
        <BorderlessFloatingButton />

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

        {/* 全局快速搜索 */}
        <QuickSearch open={quickSearchOpen} onClose={closeQuickSearch} />
      </div>
    </TooltipProvider>
  );
}
