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
import { toast } from "sonner";
import i18n from "@/i18n";
import {
  usePanesStore,
  useActivityBarStore,
  useFileBrowserStore,
  useEditorTabsStore,
} from "@/stores";
import { isTauriRuntime } from "@/services/runtime";
import { computeGlobalTabNumbers } from "@/lib/tabNumbering";
import { collectPanels } from "@/stores/paneTreeHelpers";

import type { CliTool, LaunchProviderSelection, SshConnectionInfo, WslLaunchInfo } from "@/types";

interface OrchestratorLaunchPayload {
  taskId: string;
  sessionId: string;
  projectPath: string;
  projectId: string;
  workspaceName?: string;
  providerId?: string;
  providerSelection?: LaunchProviderSelection;
  workspacePath?: string;
  title?: string;
  resumeId?: string;  // 对应 Rust OrchestratorLaunchEvent.resume_id
  paneId?: string;
  layoutId?: string;
  layoutName?: string;
  cliTool?: string;
  runtimeKind?: string;
  runtimeSource?: string;
  notice?: string;
  wsl?: WslLaunchInfo;
  ssh?: SshConnectionInfo;
  /**
   * Caller's pty_session_id when this launch was triggered by another
   * cc-panes-managed Claude via MCP `launch_task`. Used by the frontend to
   * resolve a `parentTabId` for hierarchical numbering (#N.M).
   */
  parentSessionId?: string;
}

export function useOrchestratorListener() {
  useEffect(() => {
    if (!isTauriRuntime()) return;

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
            providerSelection,
            workspacePath,
            title,
            paneId: targetPaneId,
            layoutId: targetLayoutId,
            layoutName: targetLayoutName,
            cliTool: rawCliTool,
            wsl,
            ssh,
          } = event.payload;

          console.info(
            "[Orchestrator] Received launch-task event:",
            event.payload
          );

          if (!projectPath?.trim()) {
            console.warn("[Orchestrator] Ignoring launch-task without projectPath:", event.payload);
            toast.error(i18n.t("orchestratorLaunchProjectPathMissing", { ns: "panes" }));
            return;
          }

          const activityBar = useActivityBarStore.getState();
          if (activityBar.appViewMode !== "panes") {
            activityBar.setAppViewMode("panes");
          }

          const requestedLayoutName = targetLayoutName?.trim();
          const requestedLayoutId = targetLayoutId?.trim();
          let latestPanesStore = usePanesStore.getState();
          let hasExplicitLayout = false;

          if (requestedLayoutId && latestPanesStore.listLayouts().some((layout) => layout.id === requestedLayoutId)) {
            hasExplicitLayout = true;
            if (latestPanesStore.currentLayoutId !== requestedLayoutId) {
              latestPanesStore.switchLayout(requestedLayoutId);
            }
          } else if (requestedLayoutName) {
            const existingLayout = latestPanesStore
              .listLayouts()
              .find((layout) => layout.name.trim() === requestedLayoutName);
            const layoutId = existingLayout?.id ?? latestPanesStore.createLayout(requestedLayoutName);
            hasExplicitLayout = true;
            latestPanesStore = usePanesStore.getState();
            if (latestPanesStore.currentLayoutId !== layoutId) {
              latestPanesStore.switchLayout(layoutId);
            }
          }

          latestPanesStore = usePanesStore.getState();
          let activePane = latestPanesStore.activePane();

          // 解析父 tab（按 sessionId 在所有面板里搜）。一旦找到，记下它所在的
          // panel.id —— 这是决定子 tab 落到哪个 panel 的关键，不能等到目标
          // pane 已经确定。否则在 split-pane 下子 tab 会落到 active pane，
          // 与父分家，computeTabNumbers 会把它当成孤儿 → 层级编号失效。
          const parentSessionId = event.payload.parentSessionId;
          let parentTabId: string | undefined;
          let parentPaneId: string | undefined;
          if (parentSessionId) {
            const parentLocation = latestPanesStore.findTabBySessionAcrossLayouts(parentSessionId);
            if (parentLocation) {
              if (!hasExplicitLayout && parentLocation.layoutId !== latestPanesStore.currentLayoutId) {
                latestPanesStore.switchLayout(parentLocation.layoutId);
                latestPanesStore = usePanesStore.getState();
                activePane = latestPanesStore.activePane();
              }
              if (parentLocation.layoutId === latestPanesStore.currentLayoutId) {
                parentTabId = parentLocation.tab.id;
                parentPaneId = parentLocation.panel.id;
              }
            }
          }

          // paneId 优先级：显式 paneId（MCP 调用方传入） > 父所在 panel > active pane。
          // 父优先于 active 是为了让 launch_task 拉起的子 tab 始终落在父所在的 panel，
          // 这样无论父在不在 active pane，前缀都能渲染成 #N.M。
          let paneId: string;
          if (targetPaneId) {
            const targetPaneLocation = latestPanesStore.findPaneAcrossLayouts(targetPaneId);
            if (targetPaneLocation && targetPaneLocation.layoutId !== latestPanesStore.currentLayoutId) {
              latestPanesStore.switchLayout(targetPaneLocation.layoutId);
              latestPanesStore = usePanesStore.getState();
              activePane = latestPanesStore.activePane();
            }
            paneId = targetPaneLocation?.pane.type === "panel"
              ? targetPaneLocation.pane.id
              : (parentPaneId ?? activePane?.id ?? latestPanesStore.rootPane.id);
          } else {
            paneId = parentPaneId ?? activePane?.id ?? latestPanesStore.rootPane.id;
          }

          const resolvedCliTool = (rawCliTool || "claude") as CliTool;

          latestPanesStore.addTab(paneId, {
            projectId,
            projectPath,
            sessionId,           // 后端已创建的 PTY session，避免前端重复创建
            resumeId: event.payload.resumeId,
            workspaceName,
            providerId,
            providerSelection,
            workspacePath,
            cliTool: resolvedCliTool,
            wsl,
            ssh,
            customTitle: title,
            parentTabId,
          });
          const notice = event.payload.notice?.trim();
          if (notice) {
            toast.info(notice);
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
          // 在分屏区作为 editor tab 打开（与终端并列），去重聚焦由 openEditor 负责
          usePanesStore.getState().openEditor(projectPath, filePath, title);
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
        // 分屏区的 editor tab（跨全部布局）
        usePanesStore.getState().closeEditorTabsByPath(event.payload.filePath);
        // Files 视图的编辑器 tab（旧入口打开的文件）
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
          // 分屏区的 editor tab（跨全部布局）也计入
          files.push(...usePanesStore.getState().listEditorTabsAcrossLayouts());
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
          const currentLayoutId = panesStore.currentLayoutId;
          const layouts = panesStore.listLayouts().map((layout) => {
            const panels = collectPanels(layout.rootPane);
            const tabNumbers = computeGlobalTabNumbers(layout.rootPane);
            const panes = panels.map((p) => ({
              paneId: p.id,
              layoutId: layout.id,
              tabCount: p.tabs.length,
              isActive: layout.id === currentLayoutId && p.id === layout.activePaneId,
              tabs: p.tabs.map((t) => ({
                id: t.id,
                displayNumber: tabNumbers.get(t.id) ?? null,
                title: t.title,
                contentType: t.contentType,
                projectPath: t.projectPath,
                sessionId: t.sessionId,
              })),
            }));
            return {
              id: layout.id,
              name: layout.name,
              isCurrent: layout.id === currentLayoutId,
              activePaneId: layout.activePaneId,
              panes,
              total: panes.length,
            };
          });
          const currentLayout = layouts.find((layout) => layout.id === currentLayoutId);
          const panes = currentLayout?.panes ?? [];
          const total = panes.length;
          const data = JSON.stringify({
            panes,
            total,
            layouts,
            currentLayoutId,
            layoutCount: layouts.length,
          });
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
