import { useEffect, useRef } from "react";
import { useLayoutScopeStore, selectActiveScope } from "@/stores/useLayoutScopeStore";
import { usePanesStore } from "@/stores/usePanesStore";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useSshMachinePreferencesStore } from "@/stores/useSshMachinePreferencesStore";
import { useSshMachinesStore } from "@/stores/useSshMachinesStore";
import { findPane, generateId } from "@/lib/paneTree";
import type { LayoutSnapshotPayload, PaneNode, Tab, Workspace } from "@/types";
import {
  DEFAULT_LAYOUT_SCOPE,
  resolveLayoutScope,
  sshMachineLayoutScope,
  workspaceLayoutScope,
  type LayoutScope,
} from "@/utils/layoutScope";

interface LayoutScopeSyncContext {
  workspaceId: string | null;
  workspace: Workspace | undefined;
  activeTab: Tab | null;
  selectedMachineId: string | null;
  fallbackMachineId: string | null;
  sshViewActive: boolean;
  explicitWorkspaceChanged: boolean;
}

function activeTabFromPanes(): Tab | null {
  const state = usePanesStore.getState();
  const pane = findPane(state.rootPane, state.activePaneId);
  if (pane?.type !== "panel") return null;
  return pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? null;
}

function workspaceMatchesTab(workspace: Workspace, tab: Tab): boolean {
  const tabWorkspaceName = tab.workspaceName?.trim();
  if (tabWorkspaceName && (tabWorkspaceName === workspace.id
    || tabWorkspaceName === workspace.name
    || tabWorkspaceName === workspace.alias)) {
    return true;
  }
  return workspace.projects.some((project) => (
    project.id === tab.projectId
    || (Boolean(tab.projectPath) && project.path === tab.projectPath)
  ));
}

/** 解析当前 UI 上下文的布局空间，供同步逻辑和测试复用。 */
export function resolveLayoutScopeForSync(context: LayoutScopeSyncContext): LayoutScope {
  const activeMachineId = context.activeTab?.ssh?.machineId;
  const hasActiveSsh = Boolean(activeMachineId?.trim());
  const workspaceScope = workspaceLayoutScope(context.workspaceId);
  const selectedMachineScope = sshMachineLayoutScope(
    context.selectedMachineId ?? context.fallbackMachineId,
  );

  if (context.sshViewActive && selectedMachineScope !== DEFAULT_LAYOUT_SCOPE) {
    return selectedMachineScope;
  }
  if (hasActiveSsh && (!context.explicitWorkspaceChanged
    || (context.workspace != null && workspaceMatchesTab(context.workspace, context.activeTab!)))) {
    return resolveLayoutScope({ activeTab: context.activeTab });
  }
  return workspaceScope;
}

function clonePayload(payload: LayoutSnapshotPayload): LayoutSnapshotPayload {
  return structuredClone(payload);
}

function currentPayload(): LayoutSnapshotPayload {
  return usePanesStore.getState().exportLayoutSnapshotPayload();
}

function createEmptyPanel(): PaneNode {
  const paneId = generateId("pane");
  return {
    type: "panel",
    id: paneId,
    tabs: [],
    activeTabId: "",
  };
}

function createIndependentScopePayload(): LayoutSnapshotPayload {
  const normalRoot = createEmptyPanel();
  const starredRoot = createEmptyPanel();
  const normalId = generateId("layout");
  const starredId = generateId("layout");
  return {
    schemaVersion: 2,
    layouts: [
      {
        id: normalId,
        name: "布局 1",
        kind: "normal",
        rootPane: normalRoot,
        activePaneId: normalRoot.id,
      },
      {
        id: starredId,
        name: "星标",
        kind: "starred",
        rootPane: starredRoot,
        activePaneId: starredRoot.id,
      },
    ],
    currentLayoutId: normalId,
  };
}

function initializeAndApplyScope(targetScope: LayoutScope): void {
  const scopeStore = useLayoutScopeStore.getState();
  const currentScope = scopeStore.activeScope;
  const livePayload = currentPayload();

  // Legacy panes lived in one implicit scope. Preserve them before the first projection.
  if (!scopeStore.getScope(DEFAULT_LAYOUT_SCOPE)) {
    scopeStore.saveScope(
      DEFAULT_LAYOUT_SCOPE,
      currentScope === DEFAULT_LAYOUT_SCOPE ? livePayload : createIndependentScopePayload(),
    );
  }

  if (currentScope !== targetScope) {
    scopeStore.saveScope(currentScope, livePayload);
  }

  let targetPayload = scopeStore.getScope(targetScope);
  if (!targetPayload) {
    targetPayload = createIndependentScopePayload();
    scopeStore.saveScope(targetScope, targetPayload);
  }

  scopeStore.setActiveScope(targetScope);
  if (currentScope !== targetScope) {
    usePanesStore.getState().applyLayoutSnapshotPayload(clonePayload(targetPayload));
  }
}

export function switchLayoutScope(targetScope: LayoutScope): void {
  initializeAndApplyScope(targetScope);
}

/** 按工作空间和活动 SSH 标签隔离 panes 布局快照。 */
export function useLayoutScopeSync(): void {
  const workspaceId = useWorkspacesStore((state) => state.expandedWorkspaceId);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const activeView = useActivityBarStore((state) => state.activeView);
  const selectedMachineId = useSshMachinePreferencesStore((state) => state.selectedMachineId);
  const machines = useSshMachinesStore((state) => state.machines);
  const activeTabKey = usePanesStore((state) => {
    const pane = findPane(state.rootPane, state.activePaneId);
    if (pane?.type !== "panel") return null;
    const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId);
    return `${pane.id}\u0000${pane.activeTabId}\u0000${activeTab?.ssh?.machineId ?? ""}`;
  });
  const activeScope = useLayoutScopeStore(selectActiveScope);
  const previousWorkspaceId = useRef(workspaceId);
  const previousView = useRef(activeView);
  const explicitWorkspaceLock = useRef<{ workspaceId: string | null; tabKey: string | null } | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    const workspace = workspaceId
      ? workspaces.find((item) => item.id === workspaceId)
      : undefined;
    const activeTab = activeTabFromPanes();
    const sshViewActive = activeView === "ssh";
    const fallbackMachineId = machines[0]?.id ?? null;
    if (!initialized.current
      && !workspaceId
      && !activeTab?.ssh?.machineId
      && !selectedMachineId
      && !fallbackMachineId
      && activeScope !== DEFAULT_LAYOUT_SCOPE) {
      return;
    }
    const explicitWorkspaceChanged = initialized.current
      && previousWorkspaceId.current !== workspaceId
      && previousView.current !== "ssh";
    if (explicitWorkspaceChanged) {
      explicitWorkspaceLock.current = { workspaceId, tabKey: activeTabKey };
    } else if (sshViewActive || (explicitWorkspaceLock.current
      && explicitWorkspaceLock.current.workspaceId !== workspaceId)) {
      explicitWorkspaceLock.current = null;
    } else if (explicitWorkspaceLock.current
      && explicitWorkspaceLock.current.tabKey !== activeTabKey) {
      if (!activeTab?.ssh || !workspace || workspaceMatchesTab(workspace, activeTab)) {
        explicitWorkspaceLock.current = null;
      } else {
        explicitWorkspaceLock.current.tabKey = activeTabKey;
      }
    }
    previousWorkspaceId.current = workspaceId;
    previousView.current = activeView;
    initialized.current = true;

    const targetScope = resolveLayoutScopeForSync({
      workspaceId,
      workspace,
      activeTab,
      selectedMachineId,
      fallbackMachineId,
      sshViewActive,
      explicitWorkspaceChanged: explicitWorkspaceChanged
        || explicitWorkspaceLock.current != null,
    });
    initializeAndApplyScope(targetScope);
  }, [activeTabKey, activeScope, activeView, machines, selectedMachineId, workspaceId, workspaces]);

  useEffect(() => {
    return usePanesStore.subscribe(() => {
      const scope = useLayoutScopeStore.getState().activeScope;
      useLayoutScopeStore.getState().saveScope(scope, currentPayload());
    });
  }, []);
}

export { DEFAULT_LAYOUT_SCOPE };
