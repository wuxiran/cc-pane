import { useEffect } from "react";
import { usePanesStore, useQuickCommandsStore, useWorkspacesStore } from "@/stores";
import { findPane } from "@/lib/paneTree";

/** 项目路径所属的工作空间名（workspace-first 的快捷命令层按它加载） */
export function workspaceNameForProject(
  workspaces: ReadonlyArray<{ name: string; projects: ReadonlyArray<{ path: string }> }>,
  projectPath: string | undefined,
): string | undefined {
  if (!projectPath) return undefined;
  return workspaces.find((workspace) => workspace.projects.some((project) => project.path === projectPath))?.name;
}

export function useQuickCommandsSync(): void {
  const activeProjectPath = usePanesStore((state) => {
    const pane = findPane(state.rootPane, state.activePaneId);
    if (pane?.type !== "panel") return undefined;
    return pane.tabs.find((tab) => tab.id === pane.activeTabId)?.projectPath || undefined;
  });
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const activeWorkspaceName = workspaceNameForProject(workspaces, activeProjectPath);
  const load = useQuickCommandsStore((state) => state.load);

  useEffect(() => {
    void load({ projectPath: activeProjectPath, workspaceName: activeWorkspaceName }).catch((error) => {
      console.error("[QuickCommands] Failed to load commands:", error);
    });
  }, [activeProjectPath, activeWorkspaceName, load]);
}
