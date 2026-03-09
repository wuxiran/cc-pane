/**
 * Orchestrator 事件监听 Hook
 *
 * 监听后端 "orchestrator-launch-task" 事件，
 * 自动在前端创建新标签页并连接已有 PTY 会话。
 */
import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { usePanesStore, useActivityBarStore } from "@/stores";
import { isTauriReady } from "@/utils";

interface OrchestratorLaunchPayload {
  taskId: string;
  sessionId: string;
  projectPath: string;
  projectId: string;
  workspaceName?: string;
  providerId?: string;
  workspacePath?: string;
}

export function useOrchestratorListener() {
  useEffect(() => {
    if (!isTauriReady()) return;

    let unlisten: (() => void) | null = null;

    getCurrentWebview()
      .listen<OrchestratorLaunchPayload>("orchestrator-launch-task", (event) => {
        const {
          sessionId,
          projectPath,
          projectId,
          workspaceName,
          providerId,
          workspacePath,
        } = event.payload;

        console.info("[Orchestrator] Received launch-task event:", event.payload);

        // 1. 切换到 panes 视图
        const activityBar = useActivityBarStore.getState();
        if (activityBar.appViewMode !== "panes") {
          activityBar.setAppViewMode("panes");
        }

        // 2. 在活跃面板中添加新标签
        const panesStore = usePanesStore.getState();
        const activePane = panesStore.activePane();
        const paneId = activePane?.id ?? panesStore.rootPane.id;

        // addTab 创建标签（sessionId=null），然后立即注入已有的 sessionId
        // addTab 和 updateTabSession 都是同步 Zustand set() 操作，
        // 在下次 React render 之前就完成，TerminalView 挂载时看到的是已有 sessionId
        panesStore.addTab(
          paneId,
          projectId,
          projectPath,
          undefined, // resumeId
          workspaceName,
          providerId,
          workspacePath,
          true // launchClaude
        );

        // 找到刚创建的标签并注入 sessionId
        const updatedState = usePanesStore.getState();
        const pane = updatedState.findPaneById(paneId);
        if (pane?.type === "panel") {
          // 最后一个 tab 就是刚添加的
          const lastTab = pane.tabs[pane.tabs.length - 1];
          if (lastTab && lastTab.projectId === projectId) {
            updatedState.updateTabSession(paneId, lastTab.id, sessionId);
          }
        }
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      unlisten?.();
    };
  }, []);
}
