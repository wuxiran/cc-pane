// mode=mobile-prototype 路由（从 App.tsx 原样搬出，勿在此做行为改动）。
import { useCallback } from "react";
import MobilePrototype from "@/components/mobile/MobilePrototype";
import { usePanesStore, useWorkspacesStore } from "@/stores";
import {
  useSessionLayoutPersistence,
  useSharedLayoutSnapshotSync,
} from "@/hooks/useSessionLayoutPersistence";
import { historyService, terminalService, providerService } from "@/services";
import type { Tab, Workspace } from "@/types";

function getMobileWorkspacePath(workspace: Workspace): string | undefined {
  return workspace.path || workspace.projects.find((project) => !project.ssh)?.path || workspace.projects[0]?.path;
}

export default function MobilePrototypeRoute() {
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
