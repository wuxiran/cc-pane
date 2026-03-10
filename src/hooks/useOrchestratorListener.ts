/**
 * Orchestrator 事件监听 Hook
 *
 * 监听后端 Orchestrator 事件：
 * - orchestrator-launch-task: 自动创建新标签页并连接 PTY 会话
 * - orchestrator-open-folder: 文件浏览器导航到目录
 * - orchestrator-open-file: 编辑器打开文件标签
 * - orchestrator-close-file: 关闭编辑器标签
 * - orchestrator-query-open-files: 查询已打开文件并响应
 */
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  usePanesStore,
  useActivityBarStore,
  useFileBrowserStore,
  useEditorTabsStore,
} from "@/stores";
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

    const unlisteners: (() => void)[] = [];

    // 1. launch-task 事件
    getCurrentWebview()
      .listen<OrchestratorLaunchPayload>(
        "orchestrator-launch-task",
        (event) => {
          const {
            sessionId,
            projectPath,
            projectId,
            workspaceName,
            providerId,
            workspacePath,
          } = event.payload;

          console.info(
            "[Orchestrator] Received launch-task event:",
            event.payload
          );

          const activityBar = useActivityBarStore.getState();
          if (activityBar.appViewMode !== "panes") {
            activityBar.setAppViewMode("panes");
          }

          const panesStore = usePanesStore.getState();
          const activePane = panesStore.activePane();
          const paneId = activePane?.id ?? panesStore.rootPane.id;

          panesStore.addTab(
            paneId,
            projectId,
            projectPath,
            undefined,
            workspaceName,
            providerId,
            workspacePath,
            true
          );

          const updatedState = usePanesStore.getState();
          const pane = updatedState.findPaneById(paneId);
          if (pane?.type === "panel") {
            const lastTab = pane.tabs[pane.tabs.length - 1];
            if (lastTab && lastTab.projectId === projectId) {
              updatedState.updateTabSession(paneId, lastTab.id, sessionId);
            }
          }
        }
      )
      .then((fn) => unlisteners.push(fn));

    // 2. open-folder 事件
    getCurrentWebview()
      .listen<{ path: string }>("orchestrator-open-folder", (event) => {
        console.info(
          "[Orchestrator] Received open-folder event:",
          event.payload
        );
        useFileBrowserStore.getState().navigateTo(event.payload.path);
        const activity = useActivityBarStore.getState();
        if (activity.appViewMode !== "files") {
          activity.toggleFilesMode();
        }
      })
      .then((fn) => unlisteners.push(fn));

    // 3. open-file 事件
    getCurrentWebview()
      .listen<{ filePath: string; projectPath: string; title: string }>(
        "orchestrator-open-file",
        (event) => {
          const { filePath, projectPath, title } = event.payload;
          console.info(
            "[Orchestrator] Received open-file event:",
            event.payload
          );
          useEditorTabsStore.getState().openFile(projectPath, filePath, title);
          const activity = useActivityBarStore.getState();
          if (activity.appViewMode !== "files") {
            activity.toggleFilesMode();
          }
        }
      )
      .then((fn) => unlisteners.push(fn));

    // 4. close-file 事件
    getCurrentWebview()
      .listen<{ filePath: string }>("orchestrator-close-file", (event) => {
        console.info(
          "[Orchestrator] Received close-file event:",
          event.payload
        );
        const store = useEditorTabsStore.getState();
        const tab = store.tabs.find(
          (t) => t.filePath === event.payload.filePath
        );
        if (tab) {
          store.closeTab(tab.id);
        }
      })
      .then((fn) => unlisteners.push(fn));

    // 5. query-open-files 事件
    getCurrentWebview()
      .listen<{ requestId: string }>(
        "orchestrator-query-open-files",
        async (event) => {
          console.info(
            "[Orchestrator] Received query-open-files event:",
            event.payload
          );
          const store = useEditorTabsStore.getState();
          const files = store.tabs.map((t) => ({
            filePath: t.filePath,
            projectPath: t.projectPath,
            title: t.title,
            dirty: t.dirty,
            pinned: t.pinned ?? false,
            active: t.id === store.activeTabId,
          }));
          const data = JSON.stringify({ files, total: files.length });
          await invoke("respond_orchestrator_query", {
            requestId: event.payload.requestId,
            data,
          }).catch((e: unknown) =>
            console.error("[Orchestrator] respond query failed:", e)
          );
        }
      )
      .then((fn) => unlisteners.push(fn));

    return () => {
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, []);
}
