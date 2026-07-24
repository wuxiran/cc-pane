import { useEffect, useRef } from "react";
import { usePanesStore, useWorkspacesStore } from "@/stores";
import { findPane } from "@/stores/paneTreeHelpers";
import type { PaneNode, Workspace } from "@/types";
import { projectPathsEquivalent } from "@/utils/projectIdentity";

interface TerminalContext {
  projectPath: string;
  workspaceName?: string;
}

interface TerminalContextSelection {
  workspaceId: string;
  projectId: string;
}

interface PanesContextState {
  rootPane: PaneNode;
  activePaneId: string;
}

export function resolveTerminalContextSelection(
  context: TerminalContext,
  workspaces: Workspace[],
): TerminalContextSelection | null {
  if (!context.projectPath.trim()) return null;

  const matches = workspaces.flatMap((workspace) =>
    workspace.projects
      .filter((project) => projectPathsEquivalent(project.path, context.projectPath))
      .map((project) => ({ workspace, project })),
  );
  const workspaceName = context.workspaceName?.trim();
  const match = matches.find(({ workspace }) => workspace.name === workspaceName) ?? matches[0];
  return match
    ? { workspaceId: match.workspace.id, projectId: match.project.id }
    : null;
}

function getActiveTab(state: PanesContextState) {
  const pane = findPane(state.rootPane, state.activePaneId);
  if (pane?.type !== "panel") return null;
  const tab = pane.tabs.find((item) => item.id === pane.activeTabId);
  return tab ? { pane, tab } : null;
}

function selectActiveTerminalKey(state: PanesContextState): string | null {
  const active = getActiveTab(state);
  if (!active || active.tab.contentType !== "terminal") return null;
  return `${active.pane.id}\u0000${active.tab.id}`;
}

function getActiveTerminalContext(state: PanesContextState): TerminalContext | null {
  const active = getActiveTab(state);
  if (!active || active.tab.contentType !== "terminal") return null;
  return {
    projectPath: active.tab.projectPath,
    workspaceName: active.tab.workspaceName,
  };
}

export function useFollowActiveTerminalContext(): void {
  const activeTerminalKey = usePanesStore(selectActiveTerminalKey);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const handledKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeTerminalKey) {
      handledKeyRef.current = null;
      return;
    }
    if (handledKeyRef.current === activeTerminalKey || workspaces.length === 0) return;

    handledKeyRef.current = activeTerminalKey;
    const context = getActiveTerminalContext(usePanesStore.getState());
    if (!context) return;
    const selection = resolveTerminalContextSelection(context, workspaces);
    if (!selection) return;

    const current = useWorkspacesStore.getState();
    if (
      current.expandedWorkspaceId === selection.workspaceId
      && current.expandedProjectId === selection.projectId
    ) {
      return;
    }
    useWorkspacesStore.setState({
      expandedWorkspaceId: selection.workspaceId,
      expandedProjectId: selection.projectId,
    });
  }, [activeTerminalKey, workspaces]);
}
