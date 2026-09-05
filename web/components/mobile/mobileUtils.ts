import { collectTerminalLeaves } from "@/lib/paneSessions";
import { collectPanels } from "@/lib/paneTree";
import type { PaneNode, Panel, Tab, Workspace, WorkspaceProject } from "@/types";
import { getProjectName } from "@/utils/path";
import type { OpenedWorkspaceProject } from "./types";

export function getWorkspaceOpenPath(workspace: Workspace): string | undefined {
  return workspace.path || workspace.projects.find((project) => !project.ssh)?.path || workspace.projects[0]?.path;
}

export function toOpenedProject(workspace: Workspace, project: WorkspaceProject): OpenedWorkspaceProject {
  return {
    workspaceName: workspace.name,
    workspaceRootPath: getWorkspaceOpenPath(workspace),
    projectName: project.alias ?? getProjectName(project.path),
    projectPath: project.path,
  };
}

export function getFirstWorkspaceProject(workspaces: Workspace[]): { workspace: Workspace; project: WorkspaceProject } | null {
  for (const workspace of workspaces) {
    const project = workspace.projects[0];
    if (project) return { workspace, project };
  }
  return null;
}

export function getActiveTerminalSessionId(tab: Tab | null | undefined): string | null {
  if (!tab) return null;
  if (tab.contentType !== "terminal" || !tab.terminalRootPane) return tab.sessionId ?? null;
  const leaves = collectTerminalLeaves(tab.terminalRootPane);
  const activeLeaf = (
    tab.activeTerminalPaneId
      ? leaves.find((leaf) => leaf.id === tab.activeTerminalPaneId)
      : null
  ) ?? leaves[0];
  return activeLeaf?.sessionId ?? tab.sessionId ?? null;
}

export function getPanels(node?: PaneNode | null): Panel[] {
  return node ? collectPanels(node) : [];
}

export function tabKindLabel(tab: Tab): string {
  switch (tab.contentType) {
    case "terminal":
      return tab.cliTool && tab.cliTool !== "none" ? tab.cliTool : "terminal";
    case "file-explorer":
      return "files";
    case "editor":
      return "editor";
    case "mcp-config":
      return "mcp";
    case "skill-manager":
      return "skills";
    case "memory-manager":
      return "memory";
    default:
      return tab.contentType;
  }
}
