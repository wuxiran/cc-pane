/** Orchestrator IPC event listeners and launch-task placement. */
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { toastErr, toastInfo } from "@/lib/feedback";
import i18n from "@/i18n";
import { nextLaunchId } from "@/components/panes/terminalLaunchIdentity";
import {
  usePanesStore,
  useActivityBarStore,
  useFileBrowserStore,
  useEditorTabsStore,
  useSettingsStore,
} from "@/stores";
import { isTauriRuntime } from "@/services/runtime";
import { computeGlobalTabNumbers } from "@/lib/tabNumbering";
import { collectPanels } from "@/lib/paneTree";
import { resolveWorkspaceLaunchLayout } from "@/utils/layoutWorkspace";
import {
  notifyOpenedInOtherLayout,
  resolveBrowserPlacement,
  resolveCallerPlacement,
} from "./orchestratorOpenRouting";
import type { CliTool } from "@/types";
import type { OrchestratorLaunchPayload } from "./orchestratorLaunchPayload";

function registerAsyncListener(
  pending: Promise<UnlistenFn>,
  unlisteners: UnlistenFn[],
  isDisposed: () => boolean,
): void {
  void pending.then((unlisten) => {
    if (isDisposed()) unlisten();
    else unlisteners.push(unlisten);
  }).catch((error: unknown) => console.error("[Orchestrator] Failed to register event listener:", error));
}

function focusExistingLaunch(payload: OrchestratorLaunchPayload): boolean {
  const panes = usePanesStore.getState();
  const existing = [
    payload.sessionId?.trim() ? panes.findTabBySessionAcrossLayouts(payload.sessionId.trim()) : null,
    payload.tabId?.trim() ? panes.findTabAcrossLayouts(payload.tabId.trim()) : null,
  ].find((location) => location != null);
  if (!existing) return false;
  console.info("[Orchestrator] Ignoring duplicate launch-task event:", { sessionId: payload.sessionId, tabId: payload.tabId, existingTabId: existing.tab.id });
  if (existing.layoutId === panes.currentLayoutId) panes.selectTab(existing.panel.id, existing.tab.id);
  return true;
}

export function useOrchestratorListener() {
  useEffect(() => {
    if (!isTauriRuntime()) return;

    const unlisteners: UnlistenFn[] = [];
    let disposed = false;
    const webview = getCurrentWebview();
    const register = (pending: Promise<UnlistenFn>) => registerAsyncListener(pending, unlisteners, () => disposed);

    register(webview
      .listen<OrchestratorLaunchPayload>(
        "orchestrator-launch-task",
        (event) => {
          const {
            sessionId,
            projectPath,
            projectId,
            workspaceName,
            providerId,
            modelId,
            providerSelection,
            launchProfileId,
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
            toastErr(i18n.t("orchestratorLaunchProjectPathMissing", { ns: "panes" }));
            return;
          }

          if (focusExistingLaunch(event.payload)) return;

          const placement = event.payload.placement;
          const silent = placement === "silent";
          const followAgentLaunch =
            useSettingsStore.getState().settings?.orchestrator?.followAgentLaunch === true;

          const requestedLayoutName = targetLayoutName?.trim();
          const requestedLayoutId = targetLayoutId?.trim();
          let latestPanesStore = usePanesStore.getState();
          let hasExplicitLayout = false;
          let autoRoutedLayout = false;
          let targetLayout: string | undefined;

          if (requestedLayoutId && latestPanesStore.listLayouts().some((layout) => layout.id === requestedLayoutId)) {
            hasExplicitLayout = true;
            targetLayout = requestedLayoutId;
          } else if (requestedLayoutName) {
            const existingLayout = latestPanesStore
              .listLayouts()
              .find((layout) => layout.name.trim() === requestedLayoutName);
            const layoutId = existingLayout?.id ?? latestPanesStore.createLayout(requestedLayoutName);
            hasExplicitLayout = true;
            latestPanesStore = usePanesStore.getState();
            if (!existingLayout && workspaceName?.trim()) {
              latestPanesStore.bindLayoutWorkspace(layoutId, workspaceName);
            }
            targetLayout = layoutId;
          }

          latestPanesStore = usePanesStore.getState();

          const parentSessionId = event.payload.parentSessionId;
          let parentTabId: string | undefined;
          let parentPaneId: string | undefined;
          if (parentSessionId) {
            const parentLocation = latestPanesStore.findTabBySessionAcrossLayouts(parentSessionId);
            if (parentLocation) {
              if (!hasExplicitLayout) {
                targetLayout = parentLocation.layoutId;
              }
              if (parentLocation.layoutId === (targetLayout ?? latestPanesStore.currentLayoutId)) {
                parentTabId = parentLocation.tab.id;
                parentPaneId = parentLocation.panel.id;
              }
            }
          }

          // Explicit layout > parent session > workspace routing; only record an
          // auto-routed target here and decide whether to switch below.
          if (!hasExplicitLayout && !parentPaneId && workspaceName?.trim()) {
            const boundLayout = resolveWorkspaceLaunchLayout(
              latestPanesStore.listLayouts(),
              latestPanesStore.currentLayoutId,
              workspaceName,
            );
            if (boundLayout) {
              targetLayout = boundLayout.id;
              autoRoutedLayout = boundLayout.id !== latestPanesStore.currentLayoutId;
            }
          }

          const resolvedCliTool = (rawCliTool || "claude") as CliTool;
          const tabOpts = {
            projectId,
            launchId: nextLaunchId(),
            projectPath,
            sessionId,
            tabId: event.payload.tabId,
            terminalPaneId: event.payload.terminalPaneId,
            resumeId: event.payload.resumeId,
            workspaceName,
            providerId,
            modelId,
            providerSelection,
            launchProfileId,
            workspacePath,
            cliTool: resolvedCliTool,
            wsl,
            ssh,
            customTitle: title,
            parentTabId,
          };

          const wantsTab = placement === "tab" || placement === "background";

          let explicitPaneId: string | undefined;
          if (targetPaneId) {
            const targetPaneLocation = latestPanesStore.findPaneAcrossLayouts(targetPaneId);
            if (targetPaneLocation) {
              targetLayout = targetPaneLocation.layoutId;
              if (targetPaneLocation.pane.type === "panel") {
                explicitPaneId = targetPaneLocation.pane.id;
              }
            }
          }

          const resolvedLayoutId = targetLayout ?? latestPanesStore.currentLayoutId;
          if (
            !silent
            && resolvedLayoutId !== latestPanesStore.currentLayoutId
            && (followAgentLaunch || hasExplicitLayout || autoRoutedLayout)
          ) {
            latestPanesStore.switchLayout(resolvedLayoutId);
            latestPanesStore = usePanesStore.getState();
          }

          const writeLayoutId =
            resolvedLayoutId === latestPanesStore.currentLayoutId ? undefined : resolvedLayoutId;

          if (!writeLayoutId && !silent) {
            const activityBar = useActivityBarStore.getState();
            if (activityBar.appViewMode !== "panes") {
              activityBar.setAppViewMode("panes");
            }
          }

          const targetLayoutEntry = latestPanesStore
            .listLayouts()
            .find((layout) => layout.id === resolvedLayoutId);
          const fallbackPaneId = targetLayoutEntry?.activePaneId ?? targetLayoutEntry?.rootPane.id;

          if (explicitPaneId || targetPaneId) {
            const paneId = explicitPaneId ?? parentPaneId ?? fallbackPaneId;
            if (paneId) latestPanesStore.addTab(paneId, tabOpts, writeLayoutId);
          } else if (parentPaneId && !wantsTab) {
            latestPanesStore.openSessionBesidePane(parentPaneId, "auto", tabOpts, writeLayoutId);
          } else {
            const basePaneId = parentPaneId ?? fallbackPaneId;
            if (basePaneId) latestPanesStore.addTab(basePaneId, tabOpts, writeLayoutId);
          }

          if (writeLayoutId && !silent && targetLayoutEntry) {
            toastInfo(
              i18n.t("orchestratorLaunchedInLayout", {
                ns: "panes",
                layout: targetLayoutEntry.name,
              }),
              {
                action: {
                  label: i18n.t("orchestratorLaunchedInLayoutGoto", { ns: "panes" }),
                  onClick: () => {
                    usePanesStore.getState().switchLayout(writeLayoutId);
                    useActivityBarStore.getState().setAppViewMode("panes");
                  },
                },
              },
            );
          }

          const notice = event.payload.notice?.trim();
          if (notice) {
            toastInfo(notice);
          }
        }
      )
    );

    register(webview
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
      }));

    register(webview
      .listen<{
        filePath: string;
        projectPath: string;
        title: string;
        callerSessionId?: string;
      }>(
        "orchestrator-open-file",
        (event) => {
          const { filePath, projectPath, title } = event.payload;
          console.info(
            "[Orchestrator] Received open-file event:",
            event.payload
          );
          const caller = resolveCallerPlacement(event.payload.callerSessionId);
          const landedLayoutId = usePanesStore
            .getState()
            .openEditor(projectPath, filePath, title, caller?.layoutId);
          notifyOpenedInOtherLayout(landedLayoutId, title);
        }
      ));

    register(webview
      .listen<{ filePath: string }>("orchestrator-close-file", (event) => {
        console.info(
          "[Orchestrator] Received close-file event:",
          event.payload
        );
        usePanesStore.getState().closeEditorTabsByPath(event.payload.filePath);
        const store = useEditorTabsStore.getState();
        const tab = store.tabs.find(
          (t) => t.filePath === event.payload.filePath
        );
        if (tab) {
          store.closeTab(tab.id);
        }
      }));

    register(webview
      .listen<{
        requestId?: string;
        tabId: string;
        url: string;
        title?: string;
        paneId?: string;
        reuse?: boolean;
        callerSessionId?: string;
      }>("orchestrator-open-browser-tab", async (event) => {
        const panes = usePanesStore.getState();
        const { layoutId, paneId, landedLayoutId } = resolveBrowserPlacement(event.payload);
        const activity = useActivityBarStore.getState();
        if (landedLayoutId === panes.currentLayoutId && activity.appViewMode !== "panes") {
          activity.setAppViewMode("panes");
        }
        const actualTabId = usePanesStore.getState().openBrowser(
          event.payload.url,
          event.payload.title,
          event.payload.tabId,
          { paneId, reuse: event.payload.reuse !== false, layoutId },
        );
        notifyOpenedInOtherLayout(landedLayoutId, event.payload.title || event.payload.url);
        if (event.payload.requestId) {
          await invoke("respond_orchestrator_query", {
            requestId: event.payload.requestId,
            data: JSON.stringify({ tabId: actualTabId }),
          }).catch((e: unknown) =>
            console.error("[Orchestrator] respond browser tab failed:", e)
          );
        }
      }));

    register(webview
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
          files.push(...usePanesStore.getState().listEditorTabsAcrossLayouts());
          const data = JSON.stringify({ files, total: files.length });
          await invoke("respond_orchestrator_query", {
            requestId: event.payload.requestId,
            data,
          }).catch((e: unknown) =>
            console.error("[Orchestrator] respond query failed:", e)
          );
        }
      ));

    register(webview
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
      ));

    return () => {
      disposed = true;
      for (const unlisten of unlisteners.splice(0)) {
        unlisten();
      }
    };
  }, []);
}
