import { useEffect, useCallback, useRef, useState } from "react";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import Sidebar from "@/components/Sidebar";
import TitleBar from "@/components/TitleBar";
import ActivityBar from "@/components/ActivityBar";
import StatusBar from "@/components/StatusBar";
import MiniView from "@/components/MiniView";
import { PaneContainer } from "@/components/panes";
import DndPaneProvider from "@/components/panes/DndPaneProvider";
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
import { HomeDashboard } from "@/components/home";
import { ProvidersPanel } from "@/components/providers";
import BorderlessFloatingButton from "@/components/BorderlessFloatingButton";
import OnboardingGuide from "@/components/OnboardingGuide";
import ErrorBoundary from "@/components/ErrorBoundary";

import RecentFilesPicker from "@/components/RecentFilesPicker";
import PopupTerminalWindow from "@/components/PopupTerminalWindow";
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
  useResourceStatsStore,
} from "@/stores";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useTodoReminders } from "@/hooks/useTodoReminders";
import { useWorkspaceWatcher } from "@/hooks/useWorkspaceWatcher";
import { useOrchestratorListener } from "@/hooks/useOrchestratorListener";
import { historyService, terminalService, localHistoryService, hooksService, checkUpdateSilent, markTabReclaimed as popupMarkReclaimed, getPoppedTabs, sessionRestoreService } from "@/services";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauriReady, waitForTauri } from "@/utils";
import { registerGlobalApi } from "@/utils/globalApi";
import i18n from "@/i18n";
import type { PaneNode, Panel as PanelType, OpenTerminalOptions, SavedSession } from "@/types";

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
  // 弹出窗口路由：mode=popup 时渲染纯终端视图（tabData 通过 IPC 获取）
  const params = new URLSearchParams(window.location.search);
  if (params.get("mode") === "popup") {
    return <PopupTerminalWindow />;
  }

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

  // RecentFilesPicker 状态
  const [recentFilesOpen, setRecentFilesOpen] = useState(false);
  const closeRecentFiles = useCallback(() => setRecentFilesOpen(false), []);

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

  // 退出时保存终端会话元数据 + 周期性自动保存
  useEffect(() => {
    // 收集可恢复的 Tab 并转为 SavedSession
    const collectSessions = (): SavedSession[] => {
      const tabs = usePanesStore.getState().getRestorableTabs();
      const now = new Date().toISOString();
      return tabs
        .filter(({ tab }) => tab.contentType === "terminal" && tab.projectPath)
        .map(({ tab, paneId }) => ({
          sessionId: tab.sessionId || tab.savedSessionId || tab.id,
          tabId: tab.id,
          paneId,
          projectPath: tab.projectPath,
          workspaceName: tab.workspaceName,
          workspacePath: tab.workspacePath,
          providerId: tab.providerId,
          cliTool: tab.cliTool || (tab.launchClaude ? "claude" : "none"),
          resumeId: tab.resumeId,
          claudeSessionId: undefined, // 退出时由兜底扫描填充
          sshConfig: tab.ssh ? JSON.stringify(tab.ssh) : undefined,
          customTitle: tab.title,
          createdAt: now,
          savedAt: now,
          hasOutput: false,
        }));
    };

    // 等待 Tauri IPC 就绪后再注册窗口关闭监听
    let unlistenClose: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;

    waitForTauri().then(async (ready) => {
      if (!ready) return;

      // 监听窗口关闭请求
      unlistenClose = await getCurrentWindow().onCloseRequested(async () => {
        try {
          const sessions = collectSessions();
          if (sessions.length > 0) {
            // 兜底扫描 Claude session ID
            for (const s of sessions) {
              if ((s.cliTool === "claude" || s.cliTool === "codex") && !s.claudeSessionId) {
                try {
                  const statePath = s.workspacePath || s.projectPath;
                  const state = await historyService.readSessionState(statePath);
                  if (state?.claudeSessionId) {
                    s.claudeSessionId = state.claudeSessionId;
                  }
                } catch { /* ignore */ }
              }
            }
            await sessionRestoreService.save(sessions);
            console.info(`[SessionRestore] Saved ${sessions.length} sessions on close`);
          }
        } catch (err) {
          console.error("[SessionRestore] Failed to save sessions on close:", err);
        }
        // 不阻止关闭
      });

      // 周期性保存（每 60 秒）
      timer = setInterval(async () => {
        try {
          const sessions = collectSessions();
          if (sessions.length > 0) {
            await sessionRestoreService.save(sessions);
          }
        } catch { /* silent */ }
      }, 60_000);
    });

    return () => {
      unlistenClose?.();
      if (timer) clearInterval(timer);
    };
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
      useResourceStatsStore.getState().init();
      // 应用启动后静默检查更新（仅写入 store，不弹窗）
      checkUpdateSilent().catch(console.error);
      // [暂时禁用] macOS 下 Dialog 按钮不可点击，暂停 onboarding 引导
      // const loadedSettings = useSettingsStore.getState().settings;
      // if (loadedSettings && !loadedSettings.general.onboardingCompleted) {
      //   localStorage.removeItem("cc-panes-layout");
      //   usePanesStore.persist.rehydrate();
      //   useDialogStore.getState().openOnboarding();
      // }
    });
    return () => {
      cancelled = true;
      useTerminalStatusStore.getState().cleanup();
      useResourceStatsStore.getState().cleanup();
    };
  }, []);

  // 重启时为 rehydrated Claude tabs touch 历史记录时间戳
  useEffect(() => {
    waitForTauri().then((ready) => {
      if (!ready) return;
      const allPanels = getAllPanels(usePanesStore.getState().rootPane);
      for (const panel of allPanels) {
        for (const tab of panel.tabs) {
          if (tab.resumeId && tab.resumeId !== "new" && tab.launchClaude) {
            historyService.touchBySessionId(tab.resumeId).then((id) => {
              if (id !== null) {
                window.dispatchEvent(new CustomEvent('cc-panes:history-updated'));
              }
            }).catch(console.error);
          }
        }
      }
    });
  }, []);

  // Ctrl+E 全局快捷键（最近文件）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "e") {
        e.preventDefault();
        setRecentFilesOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 监听 terminal-exit 事件，提取 last prompt
  useEffect(() => {
    if (!isTauriReady()) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    getCurrentWebview().listen<{ sessionId: string }>("terminal-exit", async (e) => {
      if (cancelled) return;
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
      // Spec: 终端退出时 sync_tasks → git diff → append_log
      if (info?.projectPath) {
        invoke("handle_terminal_exit_spec", { projectPath: info.projectPath })
          .catch((err: unknown) => console.warn("Spec exit handling failed:", err));
      }
      sessionMapRef.current.delete(e.payload.sessionId);
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 监听 Rust 侧 popup 窗口关闭通知（on_window_event 发射）
  useEffect(() => {
    if (!isTauriReady()) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<string>("popup-window-closing", (e) => {
      if (cancelled) return;
      const label = e.payload;
      const poppedTabs = getPoppedTabs();
      for (const [tabId, windowLabel] of poppedTabs) {
        if (windowLabel === label) {
          usePanesStore.getState().markTabReclaimed(tabId);
          popupMarkReclaimed(tabId);
          break;
        }
      }
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Fallback: 监听 popup 窗口销毁事件，防止 reclaim 事件丢失
  useEffect(() => {
    if (!isTauriReady()) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<{ label: string }>("tauri://window-destroyed", (e) => {
      if (cancelled) return;
      const label = (e.payload as { label?: string })?.label ?? "";
      if (!label.startsWith("popup-")) return;
      // 从 popupWindowService 的映射中查找对应的 tabId
      const poppedTabs = getPoppedTabs();
      for (const [tabId, windowLabel] of poppedTabs) {
        if (windowLabel === label) {
          console.info(`[popup-fallback] Window ${label} destroyed, reclaiming tab ${tabId}`);
          usePanesStore.getState().markTabReclaimed(tabId);
          popupMarkReclaimed(tabId);
          break;
        }
      }
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
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
        if (s.activePaneId) s.addTab(s.activePaneId, { projectId: "", projectPath: "" });
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
    (opts: OpenTerminalOptions) => {
      const { path, workspaceName, providerId, workspacePath, resumeId, ssh, wsl, machineName } = opts;
      // 兼容：如果有 resumeId 但没有指定 cliTool，跟随全局默认设置
      const defaultTool = useSettingsStore.getState().settings?.general.defaultCliTool ?? "claude";
      const effectiveCliTool = opts.cliTool ?? (resumeId ? defaultTool : undefined);
      const launchClaude = effectiveCliTool !== undefined && effectiveCliTool !== "none";
      const projectId = `proj-${crypto.randomUUID()}`;
      openProject({ projectId, projectPath: path, resumeId, workspaceName, providerId, workspacePath, cliTool: effectiveCliTool, ssh, wsl, machineName });
      const name = path.split(/[/\\]/).pop() || path;

      // SSH 项目：launchCwd 用 display path
      const launchCwd = ssh
        ? path  // SSH 项目的 path 已是 ssh:// display path
        : (workspacePath ?? path);

      const recordPromise = resumeId
        ? historyService.touchBySessionId(resumeId).then((existingId) => {
            if (existingId !== null) {
              window.dispatchEvent(new CustomEvent('cc-panes:history-updated'));
              return existingId;
            }
            // 回退：无已有记录时创建新记录
            return historyService.add(projectId, name, path, workspaceName, workspacePath, launchCwd, providerId).then((newId) => {
              historyService.updateSessionId(newId, resumeId).then(() => {
                window.dispatchEvent(new CustomEvent('cc-panes:history-updated'));
              }).catch(console.error);
              return newId;
            });
          })
        : historyService.add(projectId, name, path, workspaceName, workspacePath, launchCwd, providerId);

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
        // 后台（document.hidden）时暂停轮询，减少 CPU 消耗
        if (launchClaude && !resumeId) {
          const startTime = new Date().toISOString();
          let attempts = 0;
          const maxAttempts = 15; // 30 秒（15 × 2s），两种检测方式足够
          let resolved = false;
          const updateSessionMap = (rid: number, sessionId: string) => {
            for (const [ptyId, info] of sessionMapRef.current) {
              if (info.recordId === rid) {
                info.claudeSessionId = sessionId;
                sessionMapRef.current.set(ptyId, info);
              }
            }
          };
          const interval = setInterval(async () => {
            // 后台暂停：页面不可见时跳过本次轮询（不计入 attempts）
            if (document.hidden) return;
            attempts++;
            if (attempts > maxAttempts || resolved) {
              clearInterval(interval);
              return;
            }
            try {
              // 方式 1：session-state.json（hook 写入到 workspacePath || path）
              const statePath = workspacePath ?? path;
              const state = await historyService.readSessionState(statePath);
              console.debug(`[session-detect] method1: pollPath=${statePath} result=${state?.claudeSessionId ?? "null"} attempt=${attempts}`);
              if (state?.claudeSessionId) {
                resolved = true;
                clearInterval(interval);
                const detectedSessionId = state.claudeSessionId;
                await historyService.updateSessionId(recordId, detectedSessionId);
                window.dispatchEvent(new CustomEvent('cc-panes:history-updated'));
                updateSessionMap(recordId, detectedSessionId);
                // 回写 store，确保 tab.resumeId 保持最新
                for (const [ptyId, info] of sessionMapRef.current) {
                  if (info.recordId === recordId) {
                    usePanesStore.getState().updateTabClaudeSession(ptyId, detectedSessionId);
                    break;
                  }
                }
                return;
              }
              // 方式 2：~/.claude/projects/ 扫描（无需 hook）
              const detectedId = await historyService.detectClaudeSession(path, workspacePath, startTime);
              console.debug(`[session-detect] method2: projectPath=${path} wsPath=${workspacePath} after=${startTime} result=${detectedId ?? "null"} attempt=${attempts}`);
              if (detectedId) {
                resolved = true;
                clearInterval(interval);
                await historyService.updateSessionId(recordId, detectedId);
                window.dispatchEvent(new CustomEvent('cc-panes:history-updated'));
                updateSessionMap(recordId, detectedId);
                // 回写 store，确保 tab.resumeId 保持最新
                for (const [ptyId, info] of sessionMapRef.current) {
                  if (info.recordId === recordId) {
                    usePanesStore.getState().updateTabClaudeSession(ptyId, detectedId);
                    break;
                  }
                }
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
      const defaultTool = useSettingsStore.getState().settings?.general.defaultCliTool ?? "claude";
      handleOpenTerminal({
        path: pendingLaunch.path,
        workspaceName: pendingLaunch.workspaceName,
        providerId: pendingLaunch.providerId,
        workspacePath: pendingLaunch.workspacePath,
        ssh: pendingLaunch.ssh,
        wsl: pendingLaunch.wsl,
        machineName: pendingLaunch.machineName,
        cliTool: defaultTool,
      });
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
            />
            {/* 主区域：ActivityBar | Sidebar/Todo | 主内容区 */}
            <div className="flex-1 flex overflow-hidden relative z-[1]">
              <ActivityBar />
              {appViewMode === "home" ? (
                /* 首页仪表盘：占满 ActivityBar 右侧所有空间 */
                <div className="flex-1 overflow-hidden">
                  <HomeDashboard onOpenTerminal={handleOpenTerminal} />
                </div>
              ) : appViewMode === "todo" ? (
                /* Todo 全屏模式：占满 ActivityBar 右侧所有空间 */
                <div className="flex-1 overflow-hidden">
                  <TodoManager scope="" scopeRef="" />
                </div>
              ) : appViewMode === "selfchat" ? (
                /* Self-Chat 全屏模式 */
                <div className="flex-1 overflow-hidden">
                  <SelfChatManager />
                </div>
              ) : appViewMode === "providers" ? (
                /* Providers 全屏模式 */
                <div className="flex-1 overflow-hidden">
                  <ProvidersPanel />
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
                  <div className="flex-1 overflow-hidden p-1.5" style={{ background: "var(--app-panel-bg)" }}>
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
                  <div className="flex-1 overflow-hidden p-1.5" style={{ background: "var(--app-panel-bg)" }}>
                    <DndPaneProvider>
                      <PaneContainer pane={rootPane} />
                    </DndPaneProvider>
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

        {/* 新手引导 */}
        <OnboardingGuide />

        {/* 最近文件选择器 */}
        <RecentFilesPicker open={recentFilesOpen} onClose={closeRecentFiles} />
      </div>
    </TooltipProvider>
  );
}
