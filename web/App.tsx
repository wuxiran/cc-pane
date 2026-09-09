import { useEffect } from "react";
import LayoutSwitcherWindow from "@/components/LayoutSwitcherWindow";
import PopupTerminalWindow from "@/components/PopupTerminalWindow";
import ErrorBoundary from "@/components/ErrorBoundary";
import WebAuthGate from "@/components/WebAuthGate";
import AppShell from "@/components/layout/AppShell";
import MobilePrototypeRoute from "@/components/layout/MobilePrototypeRoute";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useTodoReminders } from "@/hooks/useTodoReminders";
import { useWorkspaceWatcher } from "@/hooks/useWorkspaceWatcher";
import { useOrchestratorListener } from "@/hooks/useOrchestratorListener";
import { useAiPanelListener } from "@/hooks/useAiPanelListener";
import { useOrphanSessionReconciler } from "@/hooks/useOrphanSessionReconciler";
import { useHiddenSessionReporter } from "@/hooks/useHiddenSessionReporter";
import { useTabAttentionWiring } from "@/hooks/useTabAttentionWiring";
import useOrchestratorSync from "@/hooks/useOrchestratorSync";
import useLayoutSwitcherSync from "@/hooks/useLayoutSwitcherSync";
import { useLayoutScopeSync } from "@/hooks/useLayoutScopeSync";
import { useLaunchWarnings } from "@/hooks/useLaunchWarnings";
import {
  useSessionLayoutPersistence,
  useSharedLayoutSnapshotSync,
  useStartupTerminalRestoreBarrier,
} from "@/hooks/useSessionLayoutPersistence";
import { useTerminalResumeIdBridge } from "@/hooks/useTerminalSessionRestore";
import { useAppLifecycleEarly } from "@/hooks/useAppLifecycleEarly";
import { useAppLifecycleLate } from "@/hooks/useAppLifecycleLate";
import { useShortcutRegistrations } from "@/hooks/useShortcutRegistrations";
import { useOpenTerminal } from "@/hooks/useOpenTerminal";
import { useQuickCommandsSync } from "@/hooks/useQuickCommandsSync";
import { usePipeEventListener } from "@/hooks/usePipeEventListener";
import LauncherDialog from "@/components/launcher/LauncherDialog";
import { useDensityStore } from "@/stores/useDensityStore";
import { startPerformanceSampling } from "@/services/performanceService";

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

function MainApp() {
  useEffect(startPerformanceSampling, []);
  useLayoutScopeSync();
  useSessionLayoutPersistence();
  useSharedLayoutSnapshotSync();
  const terminalRestoreReady = useStartupTerminalRestoreBarrier();

  // UI 密度根部同步：store 当前档写到 <html data-density>（模块加载时已应用一次，
  // 此 effect 兜底订阅后续变更，与主题 data-theme 的应用方式一致）。
  const uiDensity = useDensityStore((s) => s.density);
  useEffect(() => {
    document.documentElement.dataset.density = uiDensity;
  }, [uiDensity]);

  // 注册全局快捷键
  useKeyboardShortcuts();

  // Todo 提醒轮询
  useTodoReminders();

  // 监听外部工作空间变更（文件系统 watcher）
  useWorkspaceWatcher();

  // 监听 Orchestrator 编排事件（自我对话 Claude 启动新任务）
  useOrchestratorListener();

  // 接收 MCP 会话驱动的 AI 面板更新与关闭事件。
  useAiPanelListener();

  // 孤儿终端会话对账回收（仅桌面端；daemon TTL 兜底覆盖 app 关闭时段）
  useOrphanSessionReconciler();
  useHiddenSessionReporter();
  useTabAttentionWiring();

  // fix(M4) review: Orchestrator 同步提升到 App 顶层，全局只挂一次。
  useOrchestratorSync();

  // 编排通信事件全局订阅，避免用户在 panel 模式时丢失一次性事件。
  usePipeEventListener();

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
  useQuickCommandsSync();
  const handleOpenTerminal = useOpenTerminal();

  if (!terminalRestoreReady) return null;

  return (
    <>
      <AppShell
        onOpenTerminal={handleOpenTerminal}
        recentFilesOpen={recentFilesOpen}
        onCloseRecentFiles={closeRecentFiles}
      />
      {/* 全局唯一启动器弹窗（产物走 pendingLaunch，由上面的 useOpenTerminal 消费） */}
      <LauncherDialog />
    </>
  );
}
