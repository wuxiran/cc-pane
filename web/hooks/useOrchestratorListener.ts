/**
 * Orchestrator 事件监听 Hook
 *
 * 监听后端 Orchestrator 事件：
 * - orchestrator-launch-task: 自动创建新标签页并连接 PTY 会话
 * - orchestrator-open-folder: 文件浏览器导航到目录
 * - orchestrator-open-file: 编辑器打开文件标签
 * - orchestrator-close-file: 关闭编辑器标签
 * - orchestrator-query-open-files: 查询已打开文件并响应
 * - orchestrator-query-panes: 查询当前面板布局并响应
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

import type { CliTool } from "@/types";

interface OrchestratorLaunchPayload {
  taskId: string;
  sessionId: string;
  projectPath: string;
  projectId: string;
  workspaceName?: string;
  providerId?: string;
  workspacePath?: string;
  title?: string;
  resumeId?: string;  // 对应 Rust OrchestratorLaunchEvent.resume_id
  paneId?: string;
  cliTool?: string;
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
            title,
            paneId: targetPaneId,
            cliTool: rawCliTool,
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

          // 如果指定了 paneId 且有效，使用它；否则 fallback 到 activePane
          let paneId: string;
          if (targetPaneId) {
            const targetPane = panesStore.findPaneById(targetPaneId);
            paneId = targetPane?.type === "panel"
              ? targetPane.id
              : (activePane?.id ?? panesStore.rootPane.id);
          } else {
            paneId = activePane?.id ?? panesStore.rootPane.id;
          }

          const resolvedCliTool = (rawCliTool || "claude") as CliTool;
          panesStore.addTab(paneId, {
            projectId,
            projectPath,
            sessionId,           // 后端已创建的 PTY session，避免前端重复创建
            resumeId: event.payload.resumeId,
            workspaceName,
            providerId,
            workspacePath,
            cliTool: resolvedCliTool,
            customTitle: title,
          });
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

    // 6. query-panes 事件
    getCurrentWebview()
      .listen<{ requestId: string }>(
        "orchestrator-query-panes",
        async (event) => {
          console.info(
            "[Orchestrator] Received query-panes event:",
            event.payload
          );
          const panesStore = usePanesStore.getState();
          const panels = panesStore.allPanels();
          const activePaneId = panesStore.activePaneId;
          const panes = panels.map((p) => ({
            paneId: p.id,
            tabCount: p.tabs.length,
            isActive: p.id === activePaneId,
            tabs: p.tabs.map((t) => ({
              id: t.id,
              title: t.title,
              contentType: t.contentType,
              projectPath: t.projectPath,
              sessionId: t.sessionId,
            })),
          }));
          const data = JSON.stringify({ panes, total: panes.length });
          await invoke("respond_orchestrator_query", {
            requestId: event.payload.requestId,
            data,
          }).catch((e: unknown) =>
            console.error("[Orchestrator] respond query-panes failed:", e)
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
