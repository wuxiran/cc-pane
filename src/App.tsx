import { useState, useEffect, useCallback, useRef } from "react";
import { Toaster, toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import Sidebar from "@/components/Sidebar";
import GlobalTopBar from "@/components/GlobalTopBar";
import MiniView from "@/components/MiniView";
import { PaneContainer } from "@/components/panes";
import SettingsPanel from "@/components/SettingsPanel";
import JournalPanel from "@/components/JournalPanel";
import LocalHistoryPanel from "@/components/LocalHistoryPanel";
import SessionCleanerPanel from "@/components/SessionCleanerPanel";
import TodoPanel from "@/components/TodoPanel";
import PlansPanel from "@/components/PlansPanel";
import BorderlessFloatingButton from "@/components/BorderlessFloatingButton";
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
import { historyService, terminalService, localHistoryService, hooksService } from "@/services";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import { waitForTauri } from "@/utils";
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
  const isDark = useThemeStore((s) => s.isDark);
  const isMiniMode = useMiniModeStore((s) => s.isMiniMode);

  const rootPane = usePanesStore((s) => s.rootPane);
  const openProject = usePanesStore((s) => s.openProject);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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

  // 注册全局快捷键
  useKeyboardShortcuts();

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

  // 监听 terminal-exit 事件，提取 last prompt
  useEffect(() => {
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
    (path: string, workspaceName?: string, providerId?: string, workspacePath?: string, launchClaude?: boolean, resumeId?: string) => {
      const projectId = `proj-${crypto.randomUUID()}`;
      openProject(projectId, path, resumeId, workspaceName, providerId, workspacePath, launchClaude ?? !!resumeId);
      const name = path.split(/[/\\]/).pop() || path;

      historyService.add(projectId, name, path, workspaceName).then((recordId) => {
        // Resume 启动时，直接绑定已知 sessionId
        if (resumeId) {
          historyService.updateSessionId(recordId, resumeId).catch(console.error);
        }

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

        // 新启动 Claude（非 resume）时，轮询 session-state.json 获取 claudeSessionId
        if ((launchClaude || resumeId) && !resumeId) {
          let attempts = 0;
          const maxAttempts = 30;
          const interval = setInterval(async () => {
            attempts++;
            if (attempts > maxAttempts) {
              clearInterval(interval);
              return;
            }
            try {
              const state = await historyService.readSessionState(path);
              if (state?.claudeSessionId) {
                clearInterval(interval);
                await historyService.updateSessionId(recordId, state.claudeSessionId);
                // 更新 sessionMapRef 中所有匹配的条目
                for (const [ptyId, info] of sessionMapRef.current) {
                  if (info.recordId === recordId) {
                    info.claudeSessionId = state.claudeSessionId;
                    sessionMapRef.current.set(ptyId, info);
                  }
                }
              }
            } catch {
              // ignore polling errors
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

  const handleImport = useCallback(() => {
    toast.info(i18n.t("importHint", { ns: "sidebar" }));
  }, []);

  const handleNew = useCallback(() => {
    toast.info(i18n.t("newHint", { ns: "sidebar" }));
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
            <GlobalTopBar
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={() => setSidebarCollapsed((prev) => !prev)}
              onImport={handleImport}
              onNew={handleNew}
            />
            {/* 主区域：Sidebar | 主内容区 */}
            <div className="flex-1 flex overflow-hidden relative z-[1]">
              {/* 侧边栏 */}
              <Sidebar
                collapsed={sidebarCollapsed}
                onToggleCollapse={() => setSidebarCollapsed((prev) => !prev)}
                onOpenTerminal={handleOpenTerminal}
                onSettings={handleSettings}
              />

              {/* 面板区域 */}
              <div className="flex-1 overflow-hidden bg-transparent p-1.5">
                <PaneContainer pane={rootPane} />
              </div>
            </div>
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
      </div>
    </TooltipProvider>
  );
}
