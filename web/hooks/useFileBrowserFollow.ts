import { useEffect, useRef } from "react";
import { useFileBrowserStore, usePanesStore, useWorkspacesStore } from "@/stores";
import type { PaneNode, Workspace } from "@/types";
import { resolveWorkspaceRootPath } from "@/utils/workspaceRootPath";

interface ComputeFollowTargetOptions {
  followKey: string | null;
  workspaces: Workspace[];
  followed: string | null;
}

function findPane(node: PaneNode, paneId: string): PaneNode | null {
  if (node.id === paneId) return node;
  if (node.type === "panel") return null;
  for (const child of node.children) {
    const pane = findPane(child, paneId);
    if (pane) return pane;
  }
  return null;
}

export function computeFollowTarget({
  followKey,
  workspaces,
  followed,
}: ComputeFollowTargetOptions): string | null {
  if (followKey === null) return null;
  const separatorIndex = followKey.indexOf("|");
  const workspaceName = (separatorIndex >= 0 ? followKey.slice(0, separatorIndex) : followKey).trim();
  const projectPath = separatorIndex >= 0 ? followKey.slice(separatorIndex + 1) : "";
  const workspace = workspaceName
    ? workspaces.find((item) => item.name === workspaceName)
    : undefined;
  const workspaceTarget = workspace ? resolveWorkspaceRootPath(workspace) : null;
  const target = workspaceTarget ?? (projectPath
    ? resolveWorkspaceRootPath({ path: projectPath, projects: [] })
    : null);
  return target && target !== followed ? target : null;
}

export function useFileBrowserFollow(): void {
  const followKey = usePanesStore((state) => {
    const pane = findPane(state.rootPane, state.activePaneId);
    if (pane?.type !== "panel") return null;
    const tab = pane.tabs.find((item) => item.id === pane.activeTabId);
    if (tab?.contentType !== "terminal") return null;
    return `${tab.workspaceName ?? ""}|${tab.projectPath ?? ""}`;
  });
  const followTerminal = useFileBrowserStore((state) => state.followTerminal);
  const navigateTo = useFileBrowserStore((state) => state.navigateTo);
  const workspaceCount = useWorkspacesStore((state) => state.workspaces.length);
  const followedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!followTerminal) {
      followedRef.current = null;
      return;
    }
    const target = computeFollowTarget({
      followKey,
      workspaces: useWorkspacesStore.getState().workspaces,
      followed: followedRef.current,
    });
    if (!target) return;
    followedRef.current = target;
    navigateTo(target);
  }, [followKey, followTerminal, navigateTo, workspaceCount]);
}
